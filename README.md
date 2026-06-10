# Resonate

> Phase 0 README — expanded with the full product story, env table, API summary, and tradeoffs in Phase 7.

**Resonate** is an AI campaign copilot for D2C brands (demo brand: Brewline, an Indian specialty-coffee D2C). The loop: **Audience → Message → Send → Learn**, with AI at every step — plain-English audiences become typed segment rules, AI drafts message variants, a separate channel-simulator service delivers them with realistic async receipts, and the insights page explains performance (including attributed revenue) in plain English.

## Layout

```
apps/crm           Next.js 15 — UI, API routes, domain layer (src/server)
apps/channel-sim   Express — delivery simulator (send API + receipt callbacks)
packages/shared    zod contracts shared by both services
prisma             schema.prisma, migrations, seed
docs               architecture, decisions, ai-workflow
```

## Local setup

```bash
pnpm install
cp apps/crm/.env.example apps/crm/.env            # fill DATABASE_URL (+ AI key from Phase 3)
cp apps/channel-sim/.env.example apps/channel-sim/.env
pnpm db:generate
pnpm dev        # CRM on :3000, channel-sim on :4001
```

Health checks: `http://localhost:3000/api/health` and `http://localhost:4001/health`.
