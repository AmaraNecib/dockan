# #204 — Guard evidence

Reviewed code SHA: `e4d1e73` (evidence files committed at `b9de16a`; the only change
after the reviewed SHA is `.scratch/` evidence, which Guard treats as
non-reviewable)
Base: `8a7a7fa35de501efee15a802430193003926633d`
Tier: High-assurance
Branch: `fix-204-dropped-amount`

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3 packages) |
| Lint | `bun run lint` | pass (`oxlint`, 0 errors) |
| Unit | `bun run test` (pre-fix head `b27c5ec`) | pass |

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3) |
| Lint | `bun run lint` | pass |
| Unit | `bun run test` | **1056 pass / 0 fail** (70 files) |
| E2E | `DOKAN_PORT=4441 DOKAN_WEB_PORT=5451 DOKAN_VAULT_PORT=4499 DOKAN_VAULT_WEB_PORT=5175 bun run test:e2e` | **75 passed** (8.2m), incl. both new `#204` specs |
| Working tree | `git status --short` | clean (only ignored `.e2e-data/`; `.dokan-port` restored) |

Isolated ports were set for all four (this lane's pair + the vault pair), so no
sibling lane contended. No flaky spec: the full suite passed first try, no reruns.

## Review evidence (High-assurance)

| File | SHA | Fresh? |
|---|---|---|
| `.scratch/reviews/204/e4d1e73-debate.md` | e4d1e73 | yes — diff to HEAD is `.scratch/` only |
| `.scratch/reviews/204/e4d1e73-test-audit.md` | e4d1e73 | yes |
| `.scratch/reviews/204/e4d1e73-code-review.md` | e4d1e73 | yes |

## Phase 3 — pre-report

- Local gates green (above).
- No push/PR/merge in this lane (per brief); CI and the hosted Greptile review are
  therefore not applicable. No CI workflow exists on this repo; the local Guard
  Phase 2 run is the gate.
- No PR description (no PR). Deferred items documented in the design and evidence
  (invalid-orphan flagging, re-entry hint).
- `.dokan-port` (tracked runtime artifact) restored to its committed value before
  the final commit; never staged except by the e2e runner's own write.

## Verdict

Guard 2 green. Ready to report; not pushed.
