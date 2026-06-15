# Decisions & tradeoffs

A running log, one entry per consequential decision. The headline tradeoffs are summarized at the end under **At scale (consolidated)**.

## Phase 8 — Copilot (optional)

### The copilot is a second consumer of the SAME domain layer
Its tools (`preview_segment`, `draft_message`, `create_and_send_campaign`) call `previewSegment` / `draftMessages` / (`createSegment` + `createCampaign` + `sendCampaign`) — the exact functions the UI routes call. There's no separate "AI backend" to drift from the product. Tool inputs are plain-English strings mapped through `segmentFromText`, so the model never hand-builds a rule AST (keeps the tool JSON-schema flat for Gemini) and the field whitelist still guarantees no hallucinated segment fields reach the DB.

### Send is gated by the system prompt, not a hard server gate
`create_and_send_campaign` contacts the whole audience, so the system prompt forbids it until the user explicitly confirms (verified: it previews + drafts + asks, sends only after "go ahead"). This is a *soft* gate — adequate for a single-tenant demo. A hard gate would split it into propose (returns a draft campaign id) + a separate confirm endpoint the user action hits; noted as the productionization step.

### Non-streaming `generateText` + `stepCountIs(8)`
Multi-step tool-calling (preview → draft → send in one turn) without a streaming client or `@ai-sdk/react`; the turn returns `{ text, toolEvents }` so the panel can render activity chips, and it's curl-testable. At scale a copilot would stream tokens + tool states over SSE.

## Phase 7 — Hardening & deploy

### Audiences are snapshotted at send time, not dynamic
`POST /campaigns/:id/send` re-evaluates the segment and freezes the matching customers into `CommunicationLog` rows. Consequences: (1) stats and the funnel are **reproducible** — they describe exactly who was contacted, not who matches the rule today; (2) **attribution is simple** — an order links to a specific communication. The cost: editing a segment after a send doesn't retro-change that campaign. **At scale**, dynamic segments are a recompute/materialization job; counts become async estimates. This is the single most-defensible product decision in the build and is intentional.

### Single tenant, no auth
One workspace, no login (SPEC non-goal). The honest tradeoff: multi-tenancy is a `tenantId` on every table + row-level scoping on every query + per-tenant rate limits and secret isolation — cross-cutting, so it's deliberately out of scope rather than half-built. The admin reset is the one privileged action and is guarded by `ADMIN_KEY`.

### Reset & reseed shares ONE deterministic generator
The demo "Reset" button (`POST /api/admin/reset`, `x-admin-key` guarded) and the CLI `pnpm db:seed` both call `reseedDatabase()` in `apps/crm/src/server/admin/reseed.ts` — same seed, same rows every run, so the demo state is reproducible to the row. The generator takes the Prisma client as a parameter (dependency injection) so it runs both under `tsx` (CLI) and inside the Next runtime (endpoint) with no app-only imports. Tradeoff: regenerating ~8k customers + ~29k orders is a bulk job (`maxDuration=60`); at real volume seeding moves offline.

### At scale (consolidated)
The interview question — *"10M customers, 1M-message campaigns: what breaks first?"* — and the answers, all detailed in the per-phase entries below:

| Concern | Today (demo) | At scale |
|---|---|---|
| Segment counts | one indexed `WHERE` over denormalized aggregates | async estimate jobs; materialized rollups |
| Audience selection | snapshot into CommunicationLog | snapshot still, but written by workers |
| Send | synchronous batched (≤~10k, `maxDuration=60`) | **outbox + worker queue**, rate-limited, per-batch idempotency |
| Receipt ingestion | one idempotent txn, bulk `UPDATE…FROM(VALUES)` | webhook → queue → **batched consumer partitioned by `campaignId`** |
| Aggregates | maintained in the order-ingest txn | async refresh / CDC off the order stream |
| Insights | live `groupBy` per request | materialized read model updated off the receipt stream |
| Live feed | 3s polling | SSE / websocket fed by the consumer |
| Simulator | in-memory timers + buffer | durable queue (this is a simulator, not the product) |
| Tenancy | single workspace | `tenantId` + row-level scoping + per-tenant limits |

## Phase 6 — Attribution + AI

### Conversion comes back through the CRM's own front door
A fraction of CLICKED messages (`CONVERSION_RATE`, default 8% per SPEC §7) place an order 10–60s later. The sim does NOT write the DB — it `POST`s to the **public `/api/orders`** with `source: "CAMPAIGN"` + `attributedCampaignId` + `attributedCommunicationId` (the CommunicationLog id). So conversions exercise the exact ingestion path real integrations use: aggregate maintenance and attribution stay in one transaction, and "attributed revenue" is just `SUM(amount) WHERE attributedCampaignId = …` (verified: dashboard + insights revenue reconcile to the paise with the raw `Order` sum). Tradeoff: real attribution windows/multi-touch are out of scope; this is last-click within the campaign.

### Conversions can legitimately outrun their own click receipt
The conversion order POSTs immediately, but the CLICKED receipt folds through the rate-limited (50 events / 3s), shuffled, retrying webhook pipeline. So a conversion can land before its comm shows `CLICKED` — the attribution link is correct (same campaign, same comm) and the status is **eventually consistent**. `verify-phase6.ts` asserts the hard invariant (every attributed order links to a comm in the same campaign) and reports CLICKED-fold progress separately rather than racing it.

### AI summarises REAL computed stats, never client numbers
`POST /api/ai/campaign-summary` takes only a `campaignId`; the server recomputes `getCampaignInsights` and feeds those numbers to the model, so the narrative can't drift from the DB. Same safety shape as NL→segment: `generateObject` + zod, one retry with the error appended, then a deterministic numbers-only fallback so the card always renders (`degraded: true` when the model is unavailable).

### Drafted messages can't reference a merge field the renderer won't fill
`POST /api/ai/draft-messages` validates every variant against the SAME `MERGE_FIELDS` whitelist the renderer uses (and enforces the SMS ≤160 limit), retrying once on violation. A hallucinated `{{token}}` is rejected before it can reach a customer as literal braces — the structural-safety story from segments, applied to copy. The builder's live preview renders against a REAL segment customer via the tested `renderForCustomer`, so what the marketer previews is exactly what sends.

## Phase 5 — Insights

### Stats are live DB aggregates, not stored counters
Every number on the dashboard and campaign detail is a `groupBy`/`aggregate` over CommunicationLog/Order at request time, so the UI reconciles exactly with the raw tables (verified: API funnel counts === raw `groupBy`). The funnel is derived from `statusCounts` using the forward-only invariant (a READ row was also delivered & sent), so `sent ⊇ delivered ⊇ read ⊇ clicked` always holds. Tradeoff: per-request aggregation is fine at this scale; at 10M rows these become materialized rollups / a read model updated off the receipt stream.

### Live feed is 3s polling, not websockets
The campaign detail page polls `GET /api/campaigns/[id]` and `/feed` every 3s. Polling is intentionally simple and robust for a single-tenant demo and reconnects trivially; at scale this is an SSE/websocket stream fed by the receipt consumer. The per-campaign table rates/revenue are two grouped aggregates for the whole table (not N+1).

## Phase 4 — Send loop (the core)

### Synchronous batched send (assumption: audiences ≤ ~10k)
`POST /api/campaigns/:id/send` snapshots the audience into CommunicationLog rows, then dispatches to the sim in batches of 100 with concurrency 5 over HMAC-signed HTTP, each batch carrying an `Idempotency-Key`. A send must never crash halfway: a batch that can't reach the sim (after one retry + backoff) marks its rows `FAILED("channel_unreachable")` and the run continues; the campaign settles to `COMPLETED` once every row has left QUEUED (verified: killing the sim mid-send leaves 0 zombies). **At 10M customers / 1M-message campaigns** this becomes an **outbox + worker queue** — the route enqueues, workers drain with rate limiting and per-batch idempotency, and status is reconciled asynchronously. `export const maxDuration = 60` bounds the synchronous version.

### Idempotent webhook ingestion + forward-only state machine
`POST /api/webhooks/receipts` verifies the HMAC over the raw body and rejects batches outside a 5-minute skew window (forgery + replay-window defense). In ONE transaction it determines which `(vendorMessageId, eventType)` pairs are already in the append-only `ReceiptEvent` ledger (the idempotency key), inserts only the fresh ones, and folds ONLY those into CommunicationLog via a pure forward-only state machine (QUEUED<SENT<DELIVERED<READ<CLICKED; FAILED terminal from QUEUED/SENT). Replaying a batch therefore produces **zero duplicate state changes** (verified). A CLICKED arriving before DELIVERED still lands at CLICKED with both timestamps — order-independent.

### The fold is a single bulk UPDATE, not N updates
The first cut folded each message with its own `UPDATE` inside the interactive transaction; a 50-event batch's ~40 sequential round-trips to Neon blew the 5s transaction timeout (500s). Fixed by computing the fold in memory and applying it as one `UPDATE … FROM (VALUES …)` — four round-trips per batch regardless of size. **At scale** the webhook becomes a queue with a **partitioned batched consumer (partition by campaignId)** so receipt ingestion scales horizontally and per-campaign ordering is preserved.

### In-memory sim scheduling
The simulator schedules lifecycles with in-process timers and buffers receipts in memory, flushing every 3s (shuffled, signed). This is an acknowledged simulator tradeoff — a real vendor uses a durable queue; a process restart loses in-flight timers/buffer.

## Phase 3 — NL → Segment AI

### Provider deviation: Google/Gemini added alongside Anthropic/OpenAI
SPEC §2 locks the AI to Anthropic (primary) / OpenAI (fallback) via the Vercel AI SDK. The only key available for this build was a **Gemini** key, so a Google provider was added. The SPEC's architecture is preserved: still the Vercel AI SDK, still `generateObject` with a zod schema, still model-from-`AI_MODEL`. `getAiModel()` resolves the provider from whichever key is present (Anthropic → OpenAI → Google), so dropping in an Anthropic/OpenAI key later needs zero code changes.

### AI output is bounded for the model, then re-validated by the canonical schema
The schema handed to `generateObject` is a *non-recursive, depth-3* shape with a flat condition object — this converts cleanly to the JSON-schema subset Gemini accepts (recursive `$ref` schemas do not). The model's output is then parsed by the canonical `SegmentRulesSchema` — the single validator — which enforces the strict per-field comparator/value rules. So the AI literally cannot emit a field the compiler doesn't know; a bad shape triggers one retry with the validation error appended, then a graceful `rules: null` + helpful message. A missing provider key is the only AI condition that surfaces as an error (503), not a fallback.

### Gemini billing (resolved) + happy path verified
The Gemini key was initially billing-blocked (`429 — prepayment credits depleted`); once funding was enabled, all five SPEC verification prompts pass end to end. "high spenders in Mumbai or Delhi who haven't ordered in 90 days" → `total_spend > ₹5,000 AND city in [Mumbai, Delhi] AND last_order_days_ago > 90` (929 customers), with rupees→paise conversion, multi-city `in`, and correct date direction. "customers who love jazz" returns `rules: null` with a helpful message listing real attributes. The fail-safe path (no key / model error) degrades to a calm message, never a crash.

## Phase 2 — Segment engine

### One AST schema in `packages/shared`, three consumers
The recursive segment AST is defined once (`segment.ts`) and validated by the same `SegmentRulesSchema` at every boundary: the preview/create APIs, the visual builder (client-side, before previewing), and — in Phase 3 — the AI output. Fields and per-field comparators are whitelisted in the schema, so a hallucinated field (`loves_jazz`) is *structurally* unrepresentable: zod rejects it before the compiler ever runs. Depth is capped at 3 and empty groups are rejected by the schema, not the compiler.

### `compileRules` is pure and `now` is injected
`compileRules(ast, now)` returns a `Prisma.CustomerWhereInput` and takes no I/O, so it is exhaustively unit-tested (every comparator, nested AND/OR, date-relative inversion) without a database. Injecting `now` makes the `*_days_ago` fields deterministic. The date-relative inversion is the subtle bit: `last_order_days_ago > 90` compiles to `lastOrderAt < now − 90d` (a larger "days ago" is an older date); NULL dates (never-ordered customers) are naturally excluded.

### Segment preview reconciles with the seed
The preview endpoint counts via one indexed query over the denormalized aggregates. "High spenders gone quiet" (`total_spend ≥ ₹5,000 AND last_order_days_ago > 90`) previews **2,650** against Neon — within 2 of the seed's own independently-computed 2,648 (a day-boundary rounding difference), confirming the compiler matches intent.

### Money is entered in rupees, stored in paise
The builder's money inputs accept whole rupees (with a ₹ prefix) and store integer paise in the AST, keeping the contract canonical while the marketer thinks in rupees.

## Phase 1 — Ingestion + Customers

### Aggregates maintained incrementally inside the ingest transaction
`POST /api/orders` creates the order and updates the buyer's denormalized aggregates (`totalSpend`, `orderCount`, `avgOrderValue`, `firstOrderAt`, `lastOrderAt`) in ONE `prisma.$transaction`, so they can never drift from the underlying orders. The fold is a pure function (`applyOrderToAggregates`) that is order-independent — a late order with an earlier `placedAt` still moves `firstOrderAt` back — which is unit-tested and reused by the seed. Tradeoff (per the SPEC's interview prep): this adds write-path transaction cost; at scale aggregates become an async refresh / CDC pipeline rather than a synchronous update.

### Ingestion contracts live in `packages/shared`
`OrderInput` / `CustomerInput` / `OrderItem` zod schemas are shared because the channel simulator's conversion loop (Phase 6) posts orders back through `POST /api/orders` — the same contract validates the CRM API, the sim, and the seed's shape.

### Local verification ran against an embedded Postgres, not Neon
The dev machine has no Postgres/Docker and the SPEC's DB is Neon (provisioned at deploy). To verify Phase 1 ("seed completes; curl an order; aggregates update") without blocking on cloud credentials, the seed/migration/API were run against a user-space embedded Postgres on `localhost:5432` (matching the placeholder `DATABASE_URL`). For ongoing development and deploy, set `DATABASE_URL` to a Neon pooled connection string and run `pnpm db:deploy && pnpm db:seed`.

## Phase 0

### Shared package ships TypeScript source, not a build
`packages/shared` exports its `src/*.ts` directly. The Next.js app consumes it via `transpilePackages`; channel-sim consumes it via `tsx` in dev and bundles it via `tsup` for production. This removes an entire class of build-ordering problems inside the workspace. Tradeoff: the package is not publishable as-is — acceptable, it is internal by design.

### Initial migration generated with `prisma migrate diff` (no local database)
There is no Postgres available in the dev environment yet (Neon is provisioned at deploy time). The initial migration SQL is generated from the schema with `prisma migrate diff --from-empty --script`, so `prisma migrate deploy` works against Neon unchanged. Tradeoff: until a real database is attached, the migration is untested against a live engine.

### Typed env via lazy accessor, not import-time parse
`getEnv()` parses and caches on first access instead of at module import. Import-time parsing breaks `next build` in environments without runtime secrets (CI, preview). Fail-fast behavior is preserved: the first code path that needs env throws one aggregated, human-readable error.

### Landing page at `/`, dashboard at `/dashboard` (deviation — pending approval)
SPEC §10 puts the dashboard at `/`. The client also asked for a cinematic, immersive 3D landing experience as the site's front door. Resolution chosen: the marketing/hero experience owns `/` and the app shell starts at `/dashboard`. This is flagged as a deviation in the Phase 0 report; swapping back is a one-line route move.

### Prisma declared at the workspace root as well as in `apps/crm`
The schema lives at `/prisma` (per SPEC layout) while the client is consumed by `apps/crm`. With pnpm's isolated `node_modules`, `prisma generate` resolves `@prisma/client` relative to the schema directory — so `prisma`/`@prisma/client` are declared in the root manifest too (same version, deduped by pnpm to one physical package). This keeps `pnpm db:generate` working on fresh clones and CI without env-var workarounds.

### `shadcn` is a runtime dependency, not just a CLI
The current shadcn "base-nova" style imports `shadcn/tailwind.css` from `globals.css`. Removing the package (assuming it was CLI-only) broke `next build`; it is intentionally kept in `dependencies`.

### "Stellar Genesis" intro: one persistent canvas, the film becomes the page
The cinematic opening (solar system → meteor impact → vortex → brand star) renders in the SAME canvas as the hero scene rather than a separate intro canvas with a crossfade. The proto-sun sits exactly where the brand star lives — (0, 2.3, 0) over the reflective studio floor — so the genesis condenses in place and the handoff is a camera blend, not a scene swap. Zero-pop guarantee: during [handoff] the camera lerps toward the live hero-rig pose function (`computeRigPose`), so at blend=1 the intro pose and the idle pose are the same expression. Tradeoffs: the intro adds ~10 scene modules to the landing bundle (dynamically imported, client-only), and the studio floor stays visible under the solar system — a deliberate "the brand was always on its stage" look that also sells the reflections.

### Intro score is synthesized, not sampled, and muted by default
The cinematic's audio is generated entirely with the Web Audio API (oscillators, filtered noise, a convolution reverb built from a decaying-noise impulse) — no audio files, matching the "every asset is procedural" rule of the visuals. It is **muted by default**: browser autoplay policy forbids sound before a user gesture, so a "Sound" toggle in the hero satisfies the gesture and fades the score in. The engine is beat-driven (the timeline's `onBeat` callbacks trigger each voice), so it can join the film mid-flight if enabled late, and a returning listener who opted in resumes on their first interaction. Tradeoff: a synthesized score is less rich than a composed/mixed track, but it ships zero bytes of audio, stays on-brand, and never autoplays.

### Stateless GPU debris (25k shards, zero CPU sim)
The explosion → vortex → condensation is a pure function of four tweened uniforms evaluated in the vertex shader (ballistic-with-drag closed form, cylindrical swirl, three staggered arrival waves). No per-frame CPU particle updates, no GPGPU ping-pong — resumable, deterministic, one draw call. Tradeoff: no true inter-particle physics; acceptable because the choreography is art-directed, not simulated.

### Intro time is a dilated world clock, not the render clock
All intro motion derives from a single `world.time` ref advanced by `delta * timeScale`, so the [omen] slow-motion (1 → 0.45 → 0.2) and the snap back to 1.0 on the hit frame are globally coherent across orbits, noise fields, and trails. GSAP tweens only mutable proxy objects — never React state, never R3F-owned objects.

### AI keys optional at boot
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are optional in the env schema until Phase 3, then validated at point of use with a graceful error. Hard-requiring them in Phase 0 would block local boot for no benefit.
