# #204 — Guard evidence

Reviewed head: `aae4a7f` (code identical to `e4d1e73`; the only delta is the
`.agents/wisdom/` lesson). Full run log retained in `superseded/e4d1e73-guard.md`.
Base: `8a7a7fa35de501efee15a802430193003926633d`
Tier: High-assurance
Branch: `fix-204-dropped-amount`

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3 packages) |
| Lint | `bun run lint` | pass (`oxlint`, 0 errors) |
| Unit | `bun run test` | pass |

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3) |
| Lint | `bun run lint` | pass |
| Unit | `bun run test` | **1056 pass / 0 fail** (70 files) |
| E2E | `DOKAN_PORT=4441 DOKAN_WEB_PORT=5451 DOKAN_VAULT_PORT=4499 DOKAN_VAULT_WEB_PORT=5175 bun run test:e2e` | **75 passed** (8.2m), incl. both new `#204` specs |
| Working tree | `git status --short` | clean (only ignored artifacts; `.dokan-port` restored) |

All four ports were set (this lane's pair + the vault pair), so sibling lanes did
not contend. The full Playwright suite passed first try — no flaky spec, no rerun.

## Review evidence (High-assurance)

| File | SHA | Fresh? |
|---|---|---|
| `.scratch/reviews/204/aae4a7f-debate.md` | aae4a7f | yes — diff to HEAD is `.scratch/` only |
| `.scratch/reviews/204/aae4a7f-test-audit.md` | aae4a7f | yes |
| `.scratch/reviews/204/aae4a7f-code-review.md` | aae4a7f | yes |

Superseded `e4d1e73-*` evidence is retained under `.scratch/reviews/204/superseded/`.

## Phase 3 — pre-report

- Local gates green (above).
- No push/PR/merge in this lane (per brief); CI and hosted Greptile are not
  applicable. No CI workflow exists on this repo, so the local Guard Phase 2 run is
  the gate.
- No PR description (no PR). Deferred items documented in the design and evidence
  (invalid-orphan flagging, re-entry hint).
- Wisdom captured: `.agents/wisdom/2026-10-15-live-write-gates-not-captured-render-values.md`.

## Verdict

Guard 2 green. Ready to report; not pushed.
