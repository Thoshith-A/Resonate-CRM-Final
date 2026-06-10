# Decisions & tradeoffs

A running log, one entry per consequential decision. Finalized in Phase 7 with the "at scale" section.

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

### AI keys optional at boot
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are optional in the env schema until Phase 3, then validated at point of use with a graceful error. Hard-requiring them in Phase 0 would block local boot for no benefit.
