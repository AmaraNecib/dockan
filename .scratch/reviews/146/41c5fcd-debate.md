# #146 debate evidence (critic + defender)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round.
- **Tier:** Standard. Debate was run at the lane's request in every round.
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Evidence HEAD:** `41c5fcdc39c56f3ca4c5a3369b2ee83cf3fbb06e`
- **Supersedes:** `6e0d153-debate.md` (the pre-review-fix evidence for the same branch).

## Provenance

| round | reviewed | children | outcome |
|---|---|---|---|
| 1 | `6c6e9f4` | critic + defender | 15 findings, applied in `e231b47` |
| 2 | `e231b47` | critic + defender | 5 nits, applied in `6e0d153` |
| 3 | `cdf32c6` (the Greptile fix) | critic + defender | 10 findings, applied in `4f1d810` |
| verification | `4f1d810` | critic + defender | 7 findings, applied in `41c5fcd` (this HEAD) |

The Greptile review itself is not a child agent: it is the hosted review of PR
#188 that scored 4/5 and filed the category finding this round fixes. Its text is
reproduced in the code-review evidence.

## The regression this round fixes

Greptile at 4/5: after creating a purchase item, the shared success reset ran
`setFields(spec.empty())`, which cleared `categoryId`. Purchase's **old** handler
cleared the item fields and deliberately kept `quickCategoryId`, so the owner
could stock several items from one category pick. The shared reset forced a
re-pick for every item, or the create stopped with `itemsChooseCategory`.

This is the class of bug a shared lifecycle step invites: the reset is written
from the union of what the callers clear, and nothing in the code records what
each caller *kept*. The field still exists in the bag, so the extraction reads as
complete; it is simply never populated again.

## Round 3 (reviewed `cdf32c6`)

Critic and defender both confirmed the Greptile fix was real and that the
per-field accounting held for both screens. The critic's primary instruction was
to walk every field the shared reset touches against each screen's old handler,
which it did:

- **Purchase.** Old handler cleared `name`, `barcode`, `sellPrice`, `threshold`,
  `unitCost` and reset `qty` to `"1"`; it kept only `quickCategoryId`. The new
  `empty()` plus `keepOnCreate: ["categoryId"]` reproduces that exactly.
- **Sale.** Old handler preserved nothing: it closed the form, and every
  `openQuick()` rebuilt the bag and re-seeded the category default. The new
  `resetOnOpen: true` plus `keepOnCreate: []` reproduces the same next-open state,
  so sale is unaffected.

Findings applied in `4f1d810`:

1. `nextBag` mutated the object `empty()` returned (critic 3) - copied now.
2. `keepOnCreate` non-empty with `resetOnOpen: true` was type-legal and
   self-contradictory, because `openForm` rebuilds from `empty()` (edge hunter,
   ORANGE) - the spec type is a discriminated union now.
3. The reset read the render-time `fields`, so a field the owner edited while the
   create was in flight was overwritten (edge hunter) - the state updater is used.
4. A refused create must not reset the bag, and that was unpinned - test added.
5. A cleared kept field was untested - test added (and strengthened in the
   verification round, see below).
6. The keep-versus-open precedence was untested - test added.
7. The mocked `itemsCreate` returned a constant id, so "two items in a row"
   proved two creates but not two landed lines (critic 4, defender, coverage) -
   the mock returns one id per distinct name now.
8. `createdItems` was reset in only one describe (edge hunter) - one file-level
   hook now.
9. Purchase's non-kept fields were unpinned at page level (coverage) - asserted.
10. The design doc claimed sale's cleared fields fix a stale `draftDirty` - that
    claim was wrong and is corrected.

Retained from earlier rounds, with reasons: the quick-add markup stays per-kind
(the `decisionRequest` in the code-review evidence), the hook stays a thin
adapter over the pure reducer, and the pre-existing `Number()` readers stay.

## Verification round (reviewed `4f1d810`)

A critic, a defender, an edge-plus-quality hunter, a coverage analyst, a
standards reviewer and a spec reviewer each verified the ten fixes and looked for
what they broke. All six agreed the Greptile behaviour is fixed and the field
accounting is correct. Findings applied in `41c5fcd` (this HEAD):

1. **A verifier's throwaway probe left the worktree typechecking red.** One child
   wrote an untracked `apps/web/src/lib/__probe.ts` while probing the union, and
   its two stale `@ts-expect-error` directives made `tsc --noEmit` exit 2. The
   child removed it; the implementer re-ran `tsc` on the clean tree and it exits
   0. This is a review-harness hazard, not a code finding, but it is worth
   recording because a red probe would have been committed unexamined.
2. **The "cleared declared field stays cleared" test was measurably vacuous.** Its
   spec's `empty()` default for the kept field was already `""`, so the test
   passed with the keep list emptied. A second spec now has a non-empty default
   (`"cat-default"`), and all five quick-add tests fail when the keep list is
   ignored.
3. **The `nextBag` copy was untested.** A spec handing back one frozen object now
   proves it: without the copy, the write into the frozen object throws.
4. **The updater reset was untested.** A test now edits the kept field while the
   create is in flight and asserts the newer value survives.
5. **The union's arms duplicated `empty()` and its docstring.** Hoisted into a
   `QuickAddBag` base type, matching the shape the design doc already described.
6. **The mount state aliased the spec's object.** `useState` copies it now.
7. **Inference could be widened by a future `onCreated` edit.** Both page call
   sites pass `F` explicitly now.

Also from this round: the seed-precedence test gained a leftover field so it
distinguishes "retained bag" from "rebuilt then merged"; the page test re-creates
the same name to prove the line is replaced rather than a third appended; the
mock comment now states that one id per distinct name is a fixture fiction that
the #162 relink test depends on; and the design doc's sale paragraph no longer
overclaims.

## Residual risk (named, not hidden)

- The required `keepOnCreate` forces every caller to *answer* the question. It
  cannot prove the answer is complete: a future screen can declare `[]` and
  silently drop a field its old handler kept, exactly as this branch did. Only
  purchase's category is pinned by a test.
- Purchase's `barcode`, `sellPrice`, `threshold` and `unitCost` resets are pinned
  structurally (through `empty()`) rather than per field at page level.
- A field the owner edits during the create is only tested for a kept field; the
  value passed to `onCreated` is deliberately the click-time bag.
- Page state outside the bag (sale's `quickStockRequired` and its focus request)
  is out of the keep policy's reach.

## Verdict

No blocker at `41c5fcd`. The Greptile regression is fixed and falsified, the
per-field accounting holds for both screens, sale is unaffected, and every
remaining gap is either tested or written down with a reason.
