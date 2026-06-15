# Resonate

**An AI campaign copilot for D2C brands.** Demo brand: *Brewline*, an Indian specialty-coffee D2C selling beans, equipment, and subscriptions.

> Brands don't lose customers loudly — they lose them silently. Resonate is the marketer-facing copilot that closes the loop: **Audience → Message → Send → Learn**, with AI at every step.

- **Audience** — describe it in plain English ("high spenders in Mumbai who haven't ordered in 90 days"); AI compiles it to typed segment rules with a live preview count.
- **Message** — state an objective; AI drafts 3 personalized variants using only whitelisted merge fields.
- **Send** — a **separate channel-simulator service** delivers messages and posts back realistic, **out-of-order, batched, sometimes-duplicated** receipts over signed HTTP.
- **Learn** — the insights page shows the funnel, failures, a live-polling delivery feed, **attributed revenue** (orders placed after a click), and an **AI-written plain-English summary**.

It is deliberately scoped as a marketer's copilot, **not** an everything-CRM. Non-goals (by design): sales pipelines, support tickets, real messaging integrations, multi-tenant auth, drag-drop journey builders.

---

## Why it's built this way (the 30-second tour)

1. **Two genuinely separate services** talk over **HMAC-signed HTTP** — the CRM (Next.js) and the channel simulator (Express), with a shared zod contract package so the wire format can't silently drift.
2. **Receipts are hostile by design**: the simulator batches up to 50 events every 3s, **shuffles** them, retries, and can replay. The CRM survives this with an **append-only `ReceiptEvent` ledger** (unique `(vendorMessageId, eventType)` = idempotency key) and a **forward-only status state machine**, so out-of-order or duplicated events can never corrupt state.
3. **AI can't hallucinate its way into the system**: every AI output is `generateObject` + zod, re-validated against the *same* whitelist the rest of the app uses (segment fields, merge fields), with one retry-on-error then a graceful fallback.
4. **One domain layer, thin routes**: API handlers parse/validate and delegate to `apps/crm/src/server/*`. The same functions would back the optional copilot.

Architecture diagram, sequence diagrams, and the full tradeoffs log live in [`docs/`](docs/).

---

## Layout

```
apps/crm           Next.js 15 (App Router) — UI, API routes, domain layer (src/server)
apps/channel-sim   Express — delivery simulator (send API + receipt callbacks + conversion loop)
packages/shared    zod contracts shared by both services (channel API, webhooks, segment AST)
prisma             schema.prisma, migrations, seed.ts (deterministic Brewline data)
docs               architecture.md (mermaid), decisions.md (tradeoffs), ai-workflow.md
scripts            verification + demo helpers (verify-phaseN, run-segment, screenshots)
```

**Stack:** pnpm workspaces · Next.js 15 + TypeScript (strict) + Tailwind v4 + shadcn/base-ui · Express · Postgres (Neon) via Prisma · Vercel AI SDK (`generateObject`) with Anthropic → OpenAI → Google provider resolution · Vitest.

---

## Local setup

```bash
pnpm install

# CRM env — fill DATABASE_URL (Neon) and ONE AI provider key
cp apps/crm/.env.example apps/crm/.env
# channel-sim env — WEBHOOK_SECRET must match the CRM's
cp apps/channel-sim/.env.example apps/channel-sim/.env

pnpm db:generate          # prisma client
pnpm db:migrate           # apply migrations (or `pnpm db:deploy` against a remote DB)
pnpm db:seed              # ~8,000 customers + ~29,000 orders, deterministic

pnpm dev                  # CRM on :3000, channel-sim on :4001 (SIM_SPEED, route warmer)
```

Health checks: `http://localhost:3000/api/health` and `http://localhost:4001/health`.

> **Tip:** for a demo/recording, set `SIM_SPEED=4` in `apps/channel-sim/.env` so a full funnel plays out in ~60s on screen. After a production `build`, clear `apps/crm/.next` before `pnpm dev` (dev/turbopack and prod build write incompatible artifacts).

---

## Environment variables

### `apps/crm`
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres connection (Neon **pooled** string in prod) |
| `CHANNEL_SIM_URL` | ✅ | — | Base URL of the channel simulator |
| `WEBHOOK_SECRET` | ✅ | — | HMAC secret for signed traffic (**must match** the sim) |
| `ADMIN_KEY` | ✅ | — | Guards `POST /api/admin/reset` (the reset-&-reseed button) |
| `AI_MODEL` | — | `claude-sonnet-4-6` | Model id; must match the configured provider |
| `ANTHROPIC_API_KEY` | one of these | — | AI provider key (resolved Anthropic → OpenAI → Google) |
| `OPENAI_API_KEY` | one of these | — | " |
| `GOOGLE_GENERATIVE_AI_API_KEY` | one of these | — | " |

### `apps/channel-sim`
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CRM_URL` | ✅ | `http://localhost:3000` | CRM base URL for receipts + conversion orders |
| `WEBHOOK_SECRET` | ✅ | — | HMAC secret (**must match** the CRM) |
| `PORT` | — | `4001` | Listen port (Render injects this) |
| `SIM_SPEED` | — | `1` | Lifecycle speed multiplier (`4` for demos) |
| `CONVERSION_RATE` | — | `0.08` | Share of CLICKED messages that place an attributed order |

---

## API summary

**CRM** (`apps/crm`, all under `/api`, errors as `{ error: { code, message } }`):

| Method · Path | Purpose |
|---|---|
| `GET /health` | Liveness |
| `POST /customers`, `GET /customers`, `GET /customers/[id]` | Ingest / list / detail |
| `POST /orders` | Ingest an order (public front door; also the sim's conversion target) |
| `GET /segments`, `POST /segments`, `GET /segments/[id]` | Segment CRUD |
| `POST /segments/preview` | `{ count, sample }` for an AST (debounced live count) |
| `POST /ai/segment-from-text` | NL → segment AST (`generateObject` + zod whitelist) |
| `POST /ai/draft-messages` | 3 message variants (merge-field whitelisted, SMS ≤160) |
| `POST /ai/campaign-summary` | Plain-English summary of a campaign's real stats |
| `POST /ai/copilot` | Agentic copilot — tools (`preview_segment` / `draft_message` / `create_and_send_campaign`) call the same `src/server` functions the UI does |
| `POST /campaigns`, `GET /campaigns`, `GET /campaigns/[id]` | Create / list / insights |
| `POST /campaigns/[id]/send` | Snapshot audience → dispatch (batched, signed, idempotent) |
| `GET /campaigns/[id]/feed` | Recent comms for the live delivery feed |
| `POST /campaigns/render-preview` | Render a template against a real sample customer |
| `GET /dashboard` | Stat cards + campaign history rows |
| `POST /webhooks/receipts` | Idempotent receipt ingestion + forward-only fold |
| `POST /admin/reset` | Reset & reseed demo data (`x-admin-key` guard) |

**channel-sim** (`apps/channel-sim`): `GET /health` · `POST /v1/messages` (HMAC-verified send; 202 + vendor ids).

---

## Tests

```bash
pnpm test        # Vitest — 38 tests
```

The three suites that matter most, well-tested (SPEC §12): the **segment rule compiler**, the **status state machine** (incl. CLICKED-before-DELIVERED and duplicate-delivery), and the **template renderer**.

Phase verification scripts (run against a live local stack): `scripts/verify-phase4.ts` (idempotent replay + kill-sim consistency), `scripts/verify-phase5.ts` (insights reconcile with DB), `scripts/verify-phase6.ts` (attributed revenue reconciles; every attributed order links to a CLICKED comm).

---

## Tradeoffs & at-scale

The full log is in [`docs/decisions.md`](docs/decisions.md); the headlines:

- **Snapshot audiences, not dynamic** — sending freezes the audience into `CommunicationLog` rows. Reproducible stats and simple attribution; the cost is that a segment edited later doesn't change a past send. At scale, dynamic segments become a recompute job.
- **Synchronous batched send (≤ ~10k audiences)** — the route dispatches in batches of 100 (concurrency 5) with per-batch idempotency keys and `maxDuration=60`. **At 10M customers / 1M-message campaigns → an outbox + worker queue.**
- **Webhook → (at scale) a partitioned consumer** — receipt ingestion is one idempotent transaction with a single bulk `UPDATE … FROM (VALUES)`. At scale the webhook becomes a queue with a batched consumer partitioned by `campaignId`.
- **Denormalized customer aggregates** — `totalSpend`/`lastOrderAt`/… are maintained on order ingest so segment preview is one indexed query; the cost is write-path work, which at scale moves to async aggregate refresh / CDC.
- **Single tenant, no auth** — one workspace. Multi-tenancy = a `tenantId` on every row + row-level scoping + per-tenant rate limits.
- **In-memory simulator scheduling** — the sim uses in-process timers and an in-memory receipt buffer; a real vendor uses a durable queue. A restart drops in-flight lifecycles (acknowledged simulator tradeoff).

---

## Deploy

Targets: **CRM → Vercel**, **channel-sim → Render**, **DB → Neon**. Config lives in [`apps/crm/vercel.json`](apps/crm/vercel.json) and [`render.yaml`](render.yaml). Full runbook: [`docs/deploy.md`](docs/deploy.md).

1. **Neon** — create a project, copy the **pooled** connection string → `DATABASE_URL`.
2. **CRM → Vercel** — import the repo, root `apps/crm`. Set env (table above). `pnpm db:deploy` + `pnpm db:seed` against the Neon URL.
3. **channel-sim → Render** — root `apps/channel-sim`, build `pnpm install && pnpm build`, start `pnpm start`. Set `CRM_URL`, matching `WEBHOOK_SECRET`, `SIM_SPEED=4`.
4. Point Vercel's `CHANNEL_SIM_URL` at the Render URL; redeploy.
5. **Warm the sim** (`GET /health`) a couple of minutes before any demo — Render's free tier cold-starts (~50s).
