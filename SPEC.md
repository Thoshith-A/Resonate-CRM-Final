# SPEC.md — Resonate (source of truth)

I need a beautiful website for this — it should be 3D, immersive, cinematic, a high-end experience.

The site should feature a high-end hero section with an animation. The entire scene must be created by the agent (no external assets) — choose the best fit for the project. All assets must be programmatically created, like high-end KeyShot renders. This should blow the mind of each and every one who sees it.

You are a senior staff engineer building a take-home assignment that will be judged on product scoping, system design, code quality, and AI-nativeness. Treat this SPEC as the source of truth. Do not invent scope beyond it. If something is ambiguous, ask me before implementing. Work in the phases defined at the bottom; after each phase, stop, summarize what changed and how I can manually verify it, and wait for my approval.

## 1. Product point of view

We are building **"Resonate"** — an AI campaign copilot for D2C brands. The user is a marketer at a consumer brand (demo brand: **"Brewline"**, an Indian specialty-coffee D2C brand selling beans, equipment, and subscriptions). The core loop is:

**Audience → Message → Send → Learn**, with AI embedded at every step:
- The marketer describes an audience in plain English → AI converts it to structured segment rules with a live preview count.
- The marketer states a campaign objective → AI drafts 3 personalized message variants using customer merge fields.
- Messages dispatch through a separate **Channel Simulator service** that models real delivery: async, out-of-order receipts (delivered/failed/read/clicked) posted back via webhook.
- The insights page shows the funnel, failures, a live-updating timeline, **attributed revenue** (orders placed after a click), and an **AI-written plain-English summary** of performance.

Explicit NON-goals (do not build): sales/deal pipelines, support tickets, real messaging integrations, multi-tenant auth, drag-drop journey builders, email template designers. Single workspace, no login (note multi-tenancy as a documented tradeoff).

## 2. Tech stack (locked — do not substitute)

- Monorepo: **pnpm workspaces**. `apps/crm` (Next.js 15 App Router, TypeScript strict, Tailwind, shadcn/ui), `apps/channel-sim` (Node + Express + TypeScript), `packages/shared` (zod schemas + types shared by both services — contract-first).
- DB: **Postgres (Neon)** via **Prisma**. Pooled connection string for serverless.
- AI: **Vercel AI SDK (`ai` package)** with the Anthropic provider (fallback: OpenAI provider — read from env). Use `generateObject` with zod schemas for ALL structured AI output. Model name from env `AI_MODEL`.
- Deploy targets: CRM → Vercel. channel-sim → Render. DB → Neon. No Docker required, but the sim must run with `pnpm dev` locally.
- Validation at every boundary with zod (API inputs, webhook payloads, AI outputs, env vars via a typed `env.ts`).

## 3. Repo layout

```
/apps/crm            Next.js app (UI + API routes + service layer)
  /src/app           routes (pages + /api)
  /src/server        domain logic: segments/, campaigns/, receipts/, ai/, ingestion/
  /src/components
/apps/channel-sim    Express service (send API + receipt callbacks)
/packages/shared     zod contracts: channel API, webhook payloads, segment AST
/prisma              schema.prisma, seed.ts
/docs                architecture.md (mermaid), decisions.md (tradeoffs), ai-workflow.md
```

Rules: API route handlers are thin — they parse/validate and call `src/server/*` functions. No business logic in components or route files. No `any`, no dead code, no TODO comments left behind. Every list UI has loading, empty, and error states.

## 4. Data model (Prisma — implement exactly; add indexes as noted)

**Customer**: id (cuid), externalId (unique, nullable), name, email, phone, city, tags String[], createdAt. Denormalized aggregates maintained on order ingest: totalSpend (int, paise/cents), orderCount (int), avgOrderValue (int), firstOrderAt?, lastOrderAt?. Indexes: lastOrderAt, totalSpend, city.
**Order**: id, customerId FK, amount (int), currency ("INR"), items Json (array of {name, category, qty, price}), placedAt, source enum(ORGANIC, CAMPAIGN), attributedCampaignId?, attributedCommunicationId?. Index: customerId, placedAt, attributedCampaignId.
**Segment**: id, name, description?, rules Json (AST, §5), createdByAi Boolean, lastPreviewCount?, createdAt.
**Campaign**: id, name, objective?, segmentId FK, channel enum(WHATSAPP, SMS, EMAIL, RCS), messageTemplate (text with {{merge_fields}}), variantMeta Json?, status enum(DRAFT, SENDING, COMPLETED, FAILED), audienceSize int, createdAt, sentAt?.
**CommunicationLog**: id, campaignId FK, customerId FK, channel, renderedMessage, vendorMessageId (unique, nullable until accepted), status enum(QUEUED, SENT, FAILED, DELIVERED, READ, CLICKED), failureReason?, sentAt?, deliveredAt?, readAt?, clickedAt?, updatedAt. Indexes: (campaignId, status), vendorMessageId, customerId.
**ReceiptEvent** (append-only audit + idempotency ledger): id, vendorMessageId, eventType, occurredAt, payload Json, processedAt. **Unique constraint (vendorMessageId, eventType)** — this is the idempotency key for webhook replays.

Money is integer paise. "Opened" (email) and "read" (WhatsApp/RCS) both map to canonical status READ; label per-channel in the UI.

## 5. Segment rule engine (the heart — must be unit tested)

Rules are a recursive AST stored as JSON:

```json
{ "op": "AND", "children": [
  { "field": "total_spend", "cmp": "gt", "value": 500000 },
  { "op": "OR", "children": [
    { "field": "last_order_days_ago", "cmp": "gt", "value": 90 },
    { "field": "order_count", "cmp": "eq", "value": 0 }
  ]}
]}
```

- Whitelisted fields ONLY: `total_spend`, `order_count`, `avg_order_value`, `last_order_days_ago`, `created_days_ago`, `city` (eq/neq/in), `tags` (contains). Comparators: gt, gte, lt, lte, eq, neq, in, contains. Max nesting depth 3. Zod schema for the AST lives in `packages/shared` and is the single validator used by the API, the UI builder, and the AI output.
- `compileRules(ast) -> Prisma where clause` in `src/server/segments/compile.ts`. Pure function. **Write unit tests (Vitest)**: nested AND/OR, each comparator, date-relative fields, depth/field rejection, empty group rejection.
- `POST /api/segments/preview` → `{ count, sample: first 5 customers }`. Segment builder UI: visual nested group builder (add condition / add group, AND/OR toggle) + live preview count (debounced) + save.

## 6. Campaign send pipeline

`POST /api/campaigns` (create draft) → `POST /api/campaigns/:id/send`:
1. Re-evaluate segment, **snapshot** the audience (create one CommunicationLog row per customer, status QUEUED, message rendered server-side by replacing `{{first_name}}`, `{{city}}`, `{{last_order_days_ago}}`, `{{total_spend_rupees}}`).
2. Dispatch to the channel sim in **batches of 100** with concurrency 5: `POST {CHANNEL_SIM_URL}/v1/messages` with an HMAC-SHA256 signature header (`x-signature`, secret `WEBHOOK_SECRET`, over the raw body) and an `Idempotency-Key` per batch. Sim returns 202 with `[{ clientRef, vendorMessageId, accepted | rejected, reason? }]`. Update rows → SENT + vendorMessageId, or FAILED + reason.
3. One retry with backoff on batch-level network failure; if still failing, mark batch rows FAILED ("channel_unreachable") and continue — a campaign send must never crash halfway and leave inconsistent state. Set campaign COMPLETED when all rows leave QUEUED. `export const maxDuration = 60` on the route; documented assumption: audiences ≤ ~10k synchronous-batched; at real scale this becomes an outbox + worker queue (write this in docs/decisions.md).

## 7. Channel Simulator (apps/channel-sim) — make this convincingly real

- `POST /v1/messages`: verify HMAC, validate with shared zod schema, return **202** immediately with vendorMessageIds (uuid). ~5% of messages rejected synchronously (invalid_number, opted_out).
- For accepted messages, schedule a lifecycle with jittered timers, per-channel funnels (env-tunable, defaults):
  - WHATSAPP: 94% delivered (0.5–6s), of delivered 70% READ (2–45s), of read 28% CLICKED (2–30s). Failures: blocked, expired.
  - SMS: 96% delivered, no read receipts, 6% of delivered CLICKED.
  - EMAIL: 90% delivered, 42% READ ("opened"), 9% of read CLICKED. Failures: bounce, spam_block.
  - RCS: same shape as WhatsApp, 88% delivered.
  - `SIM_SPEED` env multiplier (default 1; set 4 in demo so a full funnel plays out in ~60s on screen).
- Receipts are NOT sent per-event. Accumulate into an in-memory buffer; every 3s flush up to 50 events as ONE batch to `POST {CRM_URL}/api/webhooks/receipts`, **deliberately shuffled** (out-of-order is a feature — it proves the CRM's state machine). HMAC-sign the batch. On non-2xx: retry with exponential backoff up to 5 times, then write to a `dead-letter.log`. In-memory scheduling is an acknowledged tradeoff for a simulator (document: real vendor = durable queue).
- **Conversion loop**: for 8% of CLICKED messages, after 10–60s the sim calls the CRM's public ingestion API `POST /api/orders` with a realistic order including `source: "CAMPAIGN"` and the attribution ids — closing the loop through the CRM's own front door and powering "revenue from this campaign".
- `GET /health`, structured request logging, config printed at boot.

## 8. Receipt ingestion (where system-design points are won)

`POST /api/webhooks/receipts` in the CRM:
1. Verify HMAC + reject stale timestamps (>5 min skew).
2. In ONE transaction: insert all events into ReceiptEvent with `ON CONFLICT (vendorMessageId, eventType) DO NOTHING` — **idempotent under vendor retries/replays**.
3. Fold only newly-inserted events into CommunicationLog: always stamp the event's timestamp column (deliveredAt/readAt/clickedAt/failure), but `status` only moves **forward** via a precedence map QUEUED(0) < SENT(1) < DELIVERED(2) < READ(3) < CLICKED(4); FAILED is terminal and only reachable from QUEUED/SENT. A CLICKED arriving before DELIVERED must end in status CLICKED with both timestamps set — write a unit test proving exactly this, plus a duplicate-delivery test.
4. Return per-event ack `{ accepted, duplicates, failed }`. Document the at-scale evolution (webhook → queue → batched consumer; partition by campaignId) in docs/decisions.md.

## 9. AI features (all via `generateObject` + shared zod schemas; every AI output is validated, one retry with the validation error appended, then graceful fallback)

1. **NL → Segment** `POST /api/ai/segment-from-text`: system prompt embeds the field whitelist + comparators + AST schema + 3 few-shot examples; returns `{ rules, explanation, suggestedName }`. UI: prompt box above the visual builder ("people in Mumbai or Delhi who spent over ₹5,000 but haven't ordered in 90 days") → AST populates the visual builder (editable — AI assists, marketer stays in control) → preview count. Hallucinated fields are impossible: zod rejects them.
2. **Message drafting** `POST /api/ai/draft-messages`: input objective + audience description + channel + brand voice ("warm, premium, concise"); returns 3 variants `{ label, text }` using only whitelisted merge fields; enforce channel limits (SMS ≤ 160 chars) in the schema; UI shows variant cards → click to load into editor.
3. **AI insight summary** `POST /api/ai/campaign-summary`: input the campaign's computed stats; returns `{ headline, narrative (≤120 words), recommendations: [2] }` — e.g. "Reached 1,284 lapsed customers; 94% delivered; clickers converted ₹48,200 in attributed revenue. Consider a follow-up to readers who didn't click." Rendered on the insights page with a regenerate button.
4. **Copilot (Phase 8, ONLY if everything else is polished)**: a chat panel where Claude has tools `preview_segment`, `draft_message`, `create_and_send_campaign` — the SAME `src/server` functions the UI calls. One brainstormed goal → executed campaign. The architecture story: one domain layer, two consumers (UI and AI).

## 10. UI (6 pages, shadcn/ui, clean and confident — this demos on video)

`/` Dashboard: stat cards (customers, campaigns, messages sent, attributed revenue) + campaign history table (most recent first: name, channel, audience, delivered %, clicked %, revenue, status badge). `/customers`: searchable paginated table + detail drawer (profile, aggregates, orders, communications). `/segments`: list + builder page (AI prompt box + visual builder + preview + save). `/campaigns/new`: 3-step flow (audience → message with AI variants + live preview on a sample customer → review & send). `/campaigns/[id]`: the showpiece — funnel bar (sent→delivered→read→clicked), failure breakdown, attributed orders & revenue, AI summary card, and a **live-polling (3s) delivery feed** so the video shows statuses flipping in real time. Plus a small Reset & Reseed demo-data button (guarded by `ADMIN_KEY`) in the nav.

Design bar: one accent color, generous whitespace, tabular numerals for stats, skeleton loaders, real seeded data everywhere (never lorem ipsum), dark-mode friendly. No design experiments — clean beats clever. The marketing/landing experience (hero) is the one sanctioned exception: 3D, immersive, cinematic, programmatic assets only.

## 11. Seed data (must look real on camera)

`prisma/seed.ts`, deterministic (seeded faker): ~8,000 customers (Indian names, cities weighted Mumbai/Delhi/Bangalore/Pune/Hyderabad, realistic emails/phones), ~35,000 orders over 18 months (coffee SKUs: beans/equipment/subscriptions; ₹300–₹6,000; seasonality). Shape the base deliberately: ~12% VIPs (5+ orders, high spend), ~30% lapsed (no order in 90+ days), ~15% one-time buyers, tags like "subscriber", "gifted", "wholesale". The demo's money moment is the segment "high spenders gone quiet" returning a juicy count.

## 12. Quality bars (non-negotiable)

TypeScript strict everywhere; zod at every boundary; typed env loader that fails fast with a clear message; Vitest unit tests for rule compiler + status state machine + template renderer (these three, well-tested, beat 50 shallow tests); consistent error envelope `{ error: { code, message } }`; README.md with: what/why (the product POV), local setup, env table, **mermaid architecture diagram** showing the two services and the callback loop, API summary, "Tradeoffs & at-scale" section (segments snapshot vs dynamic, sync batched send vs outbox/queue, webhook vs message bus, single-tenant, in-memory sim scheduling); docs/ai-workflow.md maintained by me.

## 13. Phased execution plan (work strictly in order; stop after each phase)

- **Phase 0 — Skeleton**: pnpm workspaces, both apps boot, shared package wired, Prisma schema + migration, typed env, shadcn installed, health endpoints. Verify: `pnpm dev` runs both; `/api/health` ok.
- **Phase 1 — Ingestion + Customers**: `POST /api/customers`, `POST /api/orders` (zod, upsert by externalId, aggregate maintenance in a transaction), seed script, `/customers` page + drawer. Verify: seed completes; curl an order; aggregates update.
- **Phase 2 — Segment engine**: AST schema, compiler + tests, preview API, visual builder UI, save. Verify: tests green; nested rule returns sane count.
- **Phase 3 — NL→Segment AI**: endpoint + UI integration. Verify: 5 sample prompts (including one with a disallowed field, which must fail gracefully with a helpful message).
- **Phase 4 — Send loop (the core)**: campaign create/send pipeline, channel-sim full lifecycle + batched shuffled receipts + retries, webhook ingestion + state machine + tests. Verify: send to ~1,500-customer segment; watch statuses flow; replay a receipt batch (curl) → zero duplicates; kill the sim mid-send → campaign still settles to a consistent state.
- **Phase 5 — Insights**: campaign detail page with funnel, failures, live feed, stats APIs; dashboard. Verify: numbers reconcile exactly with DB counts.
- **Phase 6 — Attribution + AI**: sim conversion loop, attributed-revenue surfacing, AI drafting, AI summary. Verify: end-to-end campaign shows revenue + summary.
- **Phase 7 — Hardening & deploy**: empty/loading/error states, reset-and-reseed endpoint, README + mermaid + decisions.md, deploy both services, smoke-test the public URL.
- **Phase 8 (optional) — Copilot chat** with tool use over the existing service layer.

## 14. Working rules for the agent

Plan before touching code each phase (files to create/change, in one short list). Never mock data the DB should provide. Never leave a feature half-wired to the UI. After implementing, run typecheck and tests and fix everything before reporting. Report format: what changed, how to verify manually in 60 seconds, any deviations from SPEC (ask first). Small, coherent commits with conventional messages.
