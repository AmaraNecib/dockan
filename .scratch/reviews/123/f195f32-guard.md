# #123 — guard evidence (review-fix round 1)

HEAD: `f195f324c6da6ba7daf6d0aa11bd16f08ce6f309`
Base: `origin/develop` @ `07ab23d561b59e4117846fb8bebbb3415533cc49`
Tier: **Standard** (web UI). Branch: `feat-123-day-first-datetime`. PR #194.

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | 3/3 packages, exit 0 |
| Lint | `bun run lint` (oxlint) | 0 warnings / 0 errors, exit 0 |
| Unit | `bun run test` (turbo) | web 891 / api 886, 0 fail, exit 0 |

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Unit | `bun run test` | web 891 / api 886, 0 fail |
| E2E | `DOKAN_PORT=4388 DOKAN_WEB_PORT=5188 bun run test:e2e` | **57 pass / 0 fail** |
| Working tree | `git status` | clean at review time (evidence files committed after) |

### E2E port note

Ports avoid `4317/5173` (shared by sibling lanes) and `4399/5174`
(`tests/e2e/vault.spec.ts` hardcodes that pair and would attach to the wrong
API). This run used `4388/5188`; the vault spec passed 3/3 in the full run.

One full run failed `receipts.spec.ts` on a `page.waitForResponse` timeout
(issue #179 class). The spec passed in isolation and on the immediate full
re-run (57/57), so it is a load flake, not a regression.

## Review evidence

- `.scratch/reviews/123/f195f32-debate.md`
- `.scratch/reviews/123/f195f32-test-audit.md`
- `.scratch/reviews/123/f195f32-code-review.md`

All three name this HEAD. `82ee0ae-*` is superseded and removed.

## Evidence SHA reconciliation

The substantive reviews ran at `d0e56e1`. Two commits landed after them:

- `fd4cf3f` — adds the guard test the test-audit asked for. Mutation-verified:
  removing the guards fails it.
- `f195f32` — extracts `applyFilterChange` from three duplicated guards. No
  behaviour change; the full unit and e2e runs above are at this SHA.

A final independent pre-merge re-check at `f195f32` returned **"No issues
found."** So the evidence is current for this HEAD.

The commit after `f195f32` adds only `.scratch/reviews/123/` evidence; the one
after that adds only `.agents/wisdom/` process notes. `git diff f195f32..HEAD --
apps/ tests/ packages/` is empty, so the code under review is unchanged and the
three reviews stand.

## Phase 3 — pre-report

- Local checks green (above).
- Review evidence current for Standard tier (debate + test-audit + code-review).
- No push and no PR update in this lane — the parent owns landing. CI/Greptile
  are therefore not run here; the local Guard 2 run is the gate.
- Deferred items documented in `f195f32-debate.md`.
