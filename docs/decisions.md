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
