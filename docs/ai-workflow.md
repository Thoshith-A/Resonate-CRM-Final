# AI workflow

> Maintained by the author. This is the honest record of how AI was used to build Resonate — the prompts that worked, the outputs that were rejected, and why.

## How this project is driven

- `SPEC.md` is the source of truth; the agent works in strict phase gates and stops for verification after each phase.
- Each phase: plan (file-level checklist) → implement → `pnpm typecheck` + `pnpm test` → manual verification steps → approval before the next phase.

## Log

### Phase 0 — skeleton
- Authored the monorepo skeleton, Prisma schema, typed env loaders, health endpoints, and the 3D landing experience with parallel sub-agents over disjoint paths, then integrated and verified centrally (typecheck, boot, curl).
- Override worth recording: `create-next-app` was rejected at the repo root by its writability probe on Windows; re-ran it from inside `apps/crm` with `.` as the target.

<!-- Add entries per phase: what the AI proposed, what was rejected/overridden, and the reasoning. -->
