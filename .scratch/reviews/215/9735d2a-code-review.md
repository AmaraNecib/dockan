# Code review — issue #215

Tier: **Standard**. Base `4bf10be`. Reviewed HEAD `9735d2a`.
Reviewers: two independent `reviewer` sub-agents (Standards axis, Spec axis),
round 2 (round 1 at `3a73b51`). Lens: `.agents/skills/code-review`.

## Standards axis

Verdict: **no hard violations.**

- Fixes exactly the two limits `.agents/wisdom/2026-10-15-display-vs-recording-order.md`
  documented: page-local (`supersededByCorrectionSeq` resolves over `projected`
  at `router.ts:614-618`) and same-second (strict `seq` compare). Reuses replay's
  own `seq`, so there is no second source of truth (ADR-0002 invariant).
- Under-annotate invariant preserved on both sides: api sets `supersededBySeq`
  only when the correction is drawn above **and** recorded later; the web keeps
  the `delta > 0` guard even on a corrupt annotation.
- Contract provably additive: both fields optional, old-client parse proven by a
  test against `stockMovementWithBalanceSchema`.
- Tier correctly Standard (display-only, no money path, no migration).

Judgement calls re-checked, not violations:
1. `isCostCorrection` + the scan loop exist on both sides — pre-existing (#151),
   cross-package, web copy is the deliberate legacy fallback. Sharing via
   `contracts` is a legitimate follow-up, not a per-ticket fix.
2. Index-aligned `Array<number | null>` re-coupled by index in the router —
   internal, 3 lines, documented, unit-tested for alignment.

Note: the reviewer flagged that `.scratch/implementation/215-design.md` appears
in the diffstat and asked to confirm `.scratch/` is not ignored. **Resolved by
the parent:** `.scratch/implementation/` is tracked in this repo (63 existing
design docs; `git check-ignore` reports no match, only `.scratch/sessions/` is
ignored), so committing the design doc is consistent with the repo.

## Spec axis

Verdict: **spec-aligned; no blocker.**

- (b) Additivity now tested in both directions: a new row parsed with the pre-215
  schema drops the unknown keys, and a stripped payload re-parses against
  `itemHistoryOutputSchema`.
- (c) The field semantics are now documented as "the nearest qualifying
  correction drawn above the row" (matching #151's fallback); the value is read
  as presence/absence only.
- No scope creep in product code; the e2e `SeedRequest` additions are test
  plumbing.
- Residual notes: (a) the same-second tie is proven at unit level only; (c) the
  exposed `seq` is the nearest referent, not the replay-segment terminator — the
  issue allows "the governing correction id" and the value is bounded and
  documented. The `recordedAfter` `seq` branch is unreachable in practice (nit).

## Gate evidence (parent-run, final source `9735d2a`)

| Command | Result |
| --- | --- |
| `bun install` | exit 0 |
| `bun run typecheck` (turbo) | 3 successful — exit 0 |
| `bun run lint` (oxlint) | 0 errors — exit 0 |
| `bun run test` (turbo + scripts) | web 1050 pass / api 918 pass / scripts 14 pass 1 skip — exit 0 |
| `bunx playwright test` (full suite, slot1: 4700/5700/4701/5701) | 74 passed, 0 failed — exit 0 |

The full Playwright suite first ran red (1 failed — the #215 e2e test set
`ui.pageSize=2` before paging the shared items list, so the seeded item was on a
later page). This was **not** flakiness or lane contention: it is a real
test-ordering bug against the shared e2e database. Fixed by opening the item
history route directly; the full suite was then re-run green and the e2e slot
was released.
