# 348 — the gate must not accept a red that never evaluated an assertion

## Tier

**High-assurance**, per `docs/engineering-workflow.md` (Review tiers). Justification: this
changes what every future PR's `RIGHT-REASON-RED` verdict *means*, for every gated test file in
`apps/`, `packages/` and `scripts/`. It is the gate that decides whether another PR's evidence is
believable, so a defect here is not one wrong row — it is a class of PRs scored on nothing.

## The defect

`scripts/red-on-parent.ts` collapses two different stand-in situations into one boolean,
`hollowed` (`isOwnRed`, ~line 700; the call site at ~line 3440 explains the collapse):

1. **hollow** — the parent has none of the module, so the gate wrote a stand-in with the same
   export names and no behaviour. The change ADDS the module.
2. **augmented** — the parent HAS the module, so the gate kept its source byte for byte and
   appended stand-ins only for the names the change adds.

Because one flag covers both, `return hollowed && failureType === "TypeError"` accepts a TypeError
in either situation. For a *hollow* that is the defect in #348: the `undefined` the body
dereferenced was produced by the gate's own fake, so the body never evaluated an assertion about
the change. For an *augmented* module the parent's real code still runs and a TypeError there has
a cause the gate cannot see, so the acceptance is a stated residual hole rather than the bug.

Measured in the issue at `b9f9cc4e`: of 101 accepted rows, 49 were `TypeError`, 52
`AssertionError`.

## The rule

One structural discrimination, no text inspection:

| stand-in written | failure type | verdict | why |
|---|---|---|---|
| none | `AssertionError` | `RIGHT_REASON_RED` | unchanged — the test's own red |
| none | `TypeError` | `WRONG_REASON_RED` | unchanged — nothing the gate wrote could have made it |
| **hollow** | `TypeError` | **`WRONG_REASON_RED`** | the fake produced the `undefined`; no assertion was evaluated. **This is #348** |
| hollow | `AssertionError` | `RIGHT_REASON_RED`, **labelled** | an assertion did evaluate, but it may have been evaluating the fake |
| **augmented** | `TypeError` | `RIGHT_REASON_RED` | unchanged by design — the parent's real code runs, so the cause is not the gate's |
| augmented | `AssertionError` | `RIGHT_REASON_RED` | unchanged |
| both | any | as **hollow** | see the tie-break below |

The discrimination is `failureType` plus *which stand-in the planner wrote*, both of which the gate
already knows. Nothing reads a failure message.

Seam change: `classifyFileRun`'s option `{ hollowed?: boolean }` becomes
`{ standIns?: StandIns }` where `StandIns = { hollow: boolean; augmented: boolean }`, so a caller
cannot collapse the two by accident again. `NO_STAND_INS` is the default.

### Why not the const-stand-in shape

The issue's second candidate — mirror `const` stand-ins so reading one is not itself a red — needs
the stand-in's *value* to be observable to the harness as "fake" without being `undefined`, and a
junit XML report carries no such channel. The honest options are a text heuristic (the first
attempt, refused: it accepts `expect(total).toBe(1000)` that merely mentions a number and rejects a
real `expected "Acme Co", received ""`) or a labelled verdict. This design takes the label: the
`RIGHT_REASON_RED` detail names the hollow, so a reviewer reading the report sees that the row was
judged against a fake. **Cost, stated plainly:** a vacuous `expect(NEW_LIMIT).toBeDefined()` is
still accepted. It is now visible in the report instead of indistinguishable from a real assertion,
and that is all the discrimination junit's failure type can carry.

### Tie-break: a file with both stand-in kinds

`planHollowModules` and `planAugmentedModules` can both write modules for one test file. When a
hollow is present, a TypeError is unproven (the vacuous dereference shape exists), so hollow
dominates. Cost: a real TypeError in the *augmented* module of such a file is rejected. Measured on
the `b9f9cc4e` diff (the issue's own measured diff) below: no file has both kinds, so the tie-break
costs nothing today, and the detail names both kinds when the case does occur.

## Planned tests (red first)

Unit (`classifyFileRun` — the classifier seam):

1. hollow + `TypeError` → `WRONG_REASON_RED`; detail names the hollow stand-in and #348.
2. augmented + `TypeError` → `RIGHT_REASON_RED`; detail names the appended stand-in.
3. no stand-in + `TypeError` → `WRONG_REASON_RED` (the ablation that already exists).
4. hollow + `AssertionError` → `RIGHT_REASON_RED`; detail carries the hollow label.
5. augmented + `AssertionError` → `RIGHT_REASON_RED`; detail carries the appended label.
6. hollow + `Error` (a hook throw) → `WRONG_REASON_RED` (unchanged).
7. both kinds + `TypeError` → `WRONG_REASON_RED`; detail names both.

End to end (real gate run on a throwaway repo — the plant pair):

1. **vacuous**: an added module plus a test that dereferences what a hollow returned
   (`turboArgs(...).args`) → `WRONG-REASON-RED`, exit 1.
2. **real**: the same module plus a test that asserts a value it produces → `RIGHT-REASON-RED`,
   exit 0. (Existing fixture; must stay green — the second attempt broke it by rejecting every
   `AssertionError` on a hollow.)
3. **augmented TypeError**: a module the parent has plus a new export the test dereferences →
   `RIGHT-REASON-RED`, exit 0. (Existing round-25 fixture; the second attempt broke it.)
4. **const stand-in**: `expect(NEW_LIMIT).toBeDefined()` → `RIGHT-REASON-RED` with the hollow label
   in the row, exit 0. (Existing fixture, now pins the label as well as the acceptance.)

No Playwright spec: the gate is a CLI over junit XML, and its own suite is the integration surface.

## Docs updated in the same commit

- `VERDICT_GUIDE.RIGHT_REASON_RED.fixes` in `scripts/red-on-parent.ts`.
- `docs/development-workflow.md` §7 (the "what the gate proves" paragraph).
- `docs/verification-and-merge-gate.md` §"What the gate proves, and what it does not".

A verdict vocabulary that says one thing while the code does another is the defect this issue is
about.

## Risks

- **False rejection of a legitimate hollow TypeError test.** A test that calls a hollow function
  and dereferences its result is exactly the shape #348 calls vacuous; a test that dereferences a
  value the *change* computes still evaluates an assertion and is an `AssertionError`
  (`expect(twice(2)).toBe(4)`), which stays accepted. The before/after counts on the `b9f9cc4e`
  diff are the evidence for how many rows move and whether any of them was real.
- **Both-kinds files** (tie-break above).
- **Docs drift.** Three copies of the vocabulary; all three edited together.

## Measurement plan

Same diff `7fa513bb..b9f9cc4e` — the issue's own measured diff, three added test files — run twice
with the current script and with the patched one, same base, same cache root for the base
worktree. Report `right-reason / wrong-reason / green-on-parent / waived` for both runs and the
files whose stand-ins made the difference.
