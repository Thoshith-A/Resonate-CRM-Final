# AI workflow

> Maintained by the author. This is the honest record of how AI was used to build Resonate — the prompts that worked, the outputs that were rejected, and why.

## How this project is driven

- `SPEC.md` is the source of truth; the agent works in strict phase gates and stops for verification after each phase.
- Each phase: plan (file-level checklist) → implement → `pnpm typecheck` + `pnpm test` → manual verification steps → approval before the next phase.

## Log

### Phase 0 — skeleton
- Authored the monorepo skeleton, Prisma schema, typed env loaders, health endpoints, and the 3D landing experience with parallel sub-agents over disjoint paths, then integrated and verified centrally (typecheck, boot, curl).
- Override worth recording: `create-next-app` was rejected at the repo root by its writability probe on Windows; re-ran it from inside `apps/crm` with `.` as the target.

### Interlude — "Stellar Genesis" cinematic intro
- Driven from a film-style creative brief (beat-by-beat timeline with named labels, art direction, acceptance criteria). The orchestration pattern: the contract files (`intro/constants.ts`, `intro/contract.ts`, shared GLSL noise) were authored first by the lead, then three scene-module agents built cosmos/system/violence in parallel against that contract, then a single "director" agent built the master GSAP timeline and integrated with the existing hero (camera blend into the live rig formula instead of a crossfade — zero-pop handoff).
- Override worth recording: the brief suggested swapping to a separate intro canvas with a ≤250ms crossfade as a fallback; rejected — the proto-sun was instead staged at the brand star's exact world position so one persistent canvas carries the whole film.
- The agent that wrote the master timeline + integration hit a session limit at its final report step, so it never ran its own verification. Picked the work up by running the verification it skipped (typecheck/lint/build, then headless beat-by-beat screenshots through a `?introT=` scrub hook). Two real runtime bugs surfaced that no static check caught:
  1. **`patch` is a reserved word in GLSL ES** — used as a variable in the planet shaders, so every planet silently failed to compile. In dev this cascaded into a fatal crash because Next's error overlay tried to `JSON.stringify` THREE's shader-error log (circular). Renamed to `blotch`.
  2. **`@react-three/postprocessing` + React 19 `ref`-as-prop** — its `wrapEffect` memoizes on `JSON.stringify(props)`, and under React 19 a forwarded `ref` lands in those props; once it resolved to the (circular) effect instance, the stringify threw and killed the tree. Fixed by constructing the effects imperatively and mounting them via `<primitive>`, which also gave direct instances to animate per-frame with zero re-renders.
- Self-critique pass against the brief flagged the [void] beat blazing from frame zero instead of emerging from black; added a `systemReveal` brightness ramp so the opening reads as deep space igniting into the system.
- Added a fully-synthesized Web Audio score (no sample files) wired to the same timeline beats, behind a muted-by-default "Sound" toggle. Verified headlessly by tapping the AudioContext output through an AnalyserNode and sampling peak amplitude over the 6.5s play — confirmed a clean dynamic arc (quiet drone → omen riser → impact hit → genesis swell → resolve fade) with the context "running" and zero console errors.

### Phase 3 — NL → Segment
- The AI never produces rules directly trusted by the system: `generateObject` fills a bounded schema, then the canonical `SegmentRulesSchema` (the same one the visual builder and API use) re-validates it. A hallucinated field is structurally impossible — it can't pass the shared zod whitelist — and an invalid shape triggers one retry-with-error then a graceful `rules: null` + helpful message. This is the "AI fails safely" story: structured output → zod whitelist → retry → graceful fallback.
- Override worth recording: the canonical segment schema is recursive (`z.lazy`), which the Gemini structured-output JSON-schema subset rejects. Rather than loosen validation, the *model-facing* schema was flattened to an explicit depth-3 shape while the *trusted* validation stayed on the canonical recursive schema — two schemas, one source of truth.
- Real finding to tell honestly in an interview: the provided Gemini key was billing-blocked (`429 prepayment credits depleted`). Because every AI output is validated and failures degrade gracefully, this surfaced as a calm "couldn't map that" message in the UI rather than a crash — exactly the safety property the design is meant to give.

### Phase 4 — Send loop + receipt ingestion
- **The override worth telling in an interview:** the first cut processed receipts **one event at a time**, each in its own write. I redirected it to fold a whole batch in **one transaction** with `ON CONFLICT (vendorMessageId, eventType) DO NOTHING`, because real vendors retry and replay entire batches — per-event processing double-counts under replay. That made idempotency a property of the schema (a unique key), not of careful code.
- **A bug only runtime caught:** the batched version then timed out — a 50-event batch did ~40 sequential `UPDATE`s inside the interactive transaction and blew Prisma's 5s limit (the request hung ~7s then 500'd). Root-caused to round-trip count, not logic; fixed by computing the fold in memory and applying it as a **single `UPDATE … FROM (VALUES …)`** (four round-trips regardless of batch size). Verified by replaying a captured batch (accepted:0, duplicates:N) and by killing the sim mid-send and confirming the campaign settled to all-FAILED with zero rows stuck in QUEUED.
- The simulator deliberately **shuffles** receipts before sending — out-of-order is a feature that proves the forward-only state machine, not a bug to smooth over. The CLICKED-before-DELIVERED unit test exists precisely to lock that in.

### Phase 5 — Insights
- Chose **live DB aggregates** over stored counters so the UI can't drift from the truth, then *proved* it: `scripts/verify-phase5.ts` reconciles every funnel number and dashboard stat against raw `groupBy` (it passed to the row). I'd rather ship a reconciliation script than assert "the numbers are right."
- Live updates are **3s polling**, not websockets — a deliberate single-tenant-demo simplification, documented rather than hidden.

### Phase 6 — Attribution + AI
- **I caught my own over-strict assumption.** My first `verify-phase6` check asserted that every attributed order's communication was *already* `CLICKED`. It failed (21/34). The cause wasn't a bug — conversion orders POST immediately, but click receipts fold through the rate-limited (50/3s), shuffled webhook pipeline, so a conversion legitimately **outruns its own click receipt**. I corrected the *invariant being tested* (same-campaign linkage is the hard guarantee; CLICKED status is eventually consistent) instead of forcing the data to match a wrong assumption. Good reminder that a failing check can mean the check is wrong.
- Extended the "AI can't hallucinate into the system" property from segments to **copy**: drafted messages are validated against the *same* merge-field whitelist the renderer uses (plus SMS ≤160), so a hallucinated `{{token}}` is rejected before it could ship as literal braces.
- Conversions close the loop through the CRM's **public `/api/orders`** (not a direct DB write), so attribution and aggregate maintenance reuse the exact ingestion path a real integration would — one code path, verified end-to-end (a send produced ₹1,04,435 across 34 orders; the sim logged exactly 34 conversions).

### Phase 8 — Copilot (agentic chat)
- The payoff of "one domain layer, thin routes": the copilot's tools (`preview_segment`, `draft_message`, `create_and_send_campaign`) call the **exact same `src/server` functions** the UI buttons call — `previewSegment` / `draftMessages` / `createSegment` + `createCampaign` + `sendCampaign`. One domain, two consumers (UI and AI); no parallel "AI path" to drift.
- **Design choice:** the tools take a plain-English `audience` string and map it through the Phase-3 `segmentFromText` path internally, rather than asking the model to hand-build a rule AST. Two wins: the model-facing tool schemas stay flat (no recursive AST → no Gemini JSON-schema-subset problem) and the whitelist safety still applies, so a hallucinated field remains structurally impossible end-to-end.
- **Honest behaviour observed in testing:** asked for "high spenders in Mumbai who haven't ordered in 90 days," the mapper declined to invent a spend threshold for the vague "high spenders" and the copilot *said so* ("I wasn't able to include a specific monetary threshold") rather than fabricating one — the graceful-degradation property surfacing in the agent.
- **Safety:** `create_and_send_campaign` dispatches to the whole audience, so the system prompt forbids calling it until the user explicitly confirms; in testing it previewed + drafted + asked, and only sent after "go ahead." This is a *prompt-level* gate (documented as a tradeoff in decisions.md — a hard gate would split propose/confirm into two server calls).
- Chose non-streaming `generateText` + `stopWhen: stepCountIs(8)` over a streaming chat: multi-step tool-calling (preview → draft → send in one turn) with zero extra client deps, and it's curl-testable.

<!-- Add entries per phase: what the AI proposed, what was rejected/overridden, and the reasoning. -->
