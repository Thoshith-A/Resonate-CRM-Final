# Decisions & tradeoffs

A running log, one entry per consequential decision. Finalized in Phase 7 with the "at scale" section.

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
