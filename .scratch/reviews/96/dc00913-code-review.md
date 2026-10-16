# Code review — issue #96 round 3

Two axes, run as separate reviewer sub-agents so neither masks the other. Base
`294a9af`, reviewed code `dc00913`, evidence HEAD the `.scratch`-only commit
after it. Three rounds (rounds 1 and 2 ran both axes with three test-audit lenses
beside them; round 3 ran one standards/spec lens over the post-round-2 delta).

## Standards

| Check | Result |
| --- | --- |
| Repo standards (`AGENTS.md`, `docs/engineering-workflow.md`, `feature-implement`, `guard`) | No breach. Tier recorded with justification (Standard); no push, no PR, no merge, no `.agents/wisdom/` write — `git diff --stat 294a9af...dc00913` touches `tests/e2e/**`, `scripts/reset-e2e-records.mjs` and `.scratch/**` only |
| Source-only policy | Only named source/test/evidence files staged; no generated artifact in the diff |
| Review evidence naming (`<issue-id>/<head-sha>-<gate>.md`) | Round 3 was the gap — this file and `dc00913-test-audit.md` close it |
| Smell baseline, round 1 | Duplicated Code / Shotgun Surgery on the reset block → **fixed** (`be50dfc`). Round 2 confirmed the extraction and that the `00`/`01` edits erased no pin (only the two `node:` imports and `00`'s local `runReset` body were deleted; every header comment and assertion is intact — the `2026-10-16-shared-fixture-edit-erases-a-pin` failure mode) |
| Smell baseline, round 2/3 | None in the delta. `E2eResetScript` is a union, not `string` (no Primitive Obsession); `runE2eReset` is not a Middle Man — it owns the data-dir default and the two-caller contract |

## Spec

Brief: `D:/projects/mani-project/.scratch/sessions/crew/briefs/issue-96-round3.md`.

| Brief demand | Verdict | Evidence |
| --- | --- | --- |
| Fix the interference: "Two fixes are legitimate… Doing both is defensible and is what I would choose." | **Met — both done.** 96 spec resets in `afterAll` (leaker cleans up), `debts.spec.ts` resets in `beforeAll` (a spec asserting a GLOBAL sum owns its precondition) | `c70f994` |
| "say in your report why you did not rely on the other alone" | **Met** | Design doc, "The principle" (why not (1) alone / why not (2) alone); rounds 1–2 both agreed the redundancy is real and honestly labelled |
| "Sweep, because this is a class… Enumerate every spec that asserts an exact count or total and state for each whether it depends on no-earlier-spec-adds-records" | **Met.** 24-row table | Design doc, "Sweep"; round 2 independently grepped 31 specs and confirmed "`debts` is the only global sum" |
| "Name any others at risk and either harden them or record them explicitly" | **Met, recorded.** `expense-reports.spec.ts:77` is the one remaining convention-dependent exact count; recorded with its own row and a Deferred entry | Design doc, "Sweep" + "Deferred" |
| "The reproduction above, failing **before** your fix in the same order, and green after" | **Met.** `1 failed, 8 passed · Expected "1200 دج" / Received "3200 دج"` at `debts.spec.ts:14:1`, then 9 passed | `round3/order3-before.log`, `round3/order3-after.log` |
| "`tests/e2e/debts.spec.ts` green when run alone, and green in the full ordering" | **Met for the spec.** Alone: 1 passed. Full ordering: `debts` passed in every run that produced results, including all six final-code attempts | `round3/debts-alone.log`, `round3/full-suite*.log` |
| "If you touch `tests/e2e-selection.map.json`, the selector's guard test must stay green" | **Met and stronger** — the map was not touched, and `tests/e2e/**` is `always_full`, so this diff forces a full e2e run | `round3/guard-phase1.log` (35 pass) |
| "State whether the new spec still passes" | **Met** — both 96 tests pass in `order3-after.log` (targets 7–8) and in the full runs | `round3/order3-after.log` |
| Full ordering green at the final commit | **Unmet locally, disclosed.** Best final-code run 92/93; the failure was the shared `signIn` wait on a loaded machine, and that test passes alone on the same code | `round3/full-suite-final.log`, `round3/full-suite-flakes.log` |

## Scope beyond the brief's two options

Four changes sit outside the two named fix options. Each is committed separately,
so the parent can drop any one without touching the interference fix:

1. `tests/e2e/expense-reports.spec.ts` — a pre-existing bare-click save race that
   the first full-suite run surfaced (`92 passed, 1 failed`). Commit `f5b8b0d`,
   tightened in `dc00913`. Proof by mutation: with the first `expensesCreate`
   response held open, the pre-fix shape fails (`Expected 250, Received 0`) and
   the fixed shape passes.
2. `scripts/reset-e2e-records.mjs` — three missing `DELETE`s, with a before/after
   row-count probe. Commit `7e6622e`.
3. `tests/e2e/reset-helpers.ts` — removes the duplication the new call sites
   created. Commit `be50dfc`.
4. `tests/e2e/00-onboarding.spec.ts`, `01-empty-states.spec.ts` — call the new
   helper. Same commit; no assertion or comment changed.

Every one is labelled in the design doc with its reason and its proof. The
rounds-1-and-2 spec lens called this "scope creep — honestly labelled", with the
justification sufficient, because the round exists to make CI green and the
expense race lands in the same suite.

## Residual risks (also in the design doc)

- `afterAll` does not survive a killed worker; no hook does.
- The 96 spec's `afterAll` cannot be falsified by any run while `debts`' own
  `beforeAll` exists — it is defence in depth, not a pinned behaviour.
- A 96-spec run dirties `.dokan-port` and rewrites the committed round-2
  screenshots (4-byte PNG difference). Pre-existing; restored before committing.
- E2E flakes run-to-run on this machine under a second crew lane. Documented
  per run, never averaged away.
