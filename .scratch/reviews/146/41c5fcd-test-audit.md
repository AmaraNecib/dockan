# #146 test-audit evidence

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round.
- **Tier:** Standard (test audit is required for Standard and High-assurance).
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Evidence HEAD:** `41c5fcdc39c56f3ca4c5a3369b2ee83cf3fbb06e`
- **Supersedes:** `6e0d153-test-audit.md`.

## Provenance

Round 3 ran an edge-case hunter, a coverage analyst and a test-quality reviewer
against `cdf32c6`. Their findings were applied in `4f1d810`. A verification round
then ran an edge-plus-quality hunter and a coverage analyst against `4f1d810`;
those findings are applied in `41c5fcd` (this HEAD).

## The behaviour under test

Purchase's quick-add must keep the picked category across a successful create
(the Greptile round-1 regression), while every other field resets, sale keeps
nothing, and a refused create touches nothing.

## Tests at `41c5fcd`

`apps/web/src/lib/use-invoice-draft.test.tsx` (hook level):

| test | what it pins |
|---|---|
| keeps only the fields the spec declares across a successful create | the declared field survives; the rest return to `empty()` |
| keeps a cleared declared field cleared rather than falling back to `empty()` | against a spec whose default for the kept field is `"cat-default"`, so an ignored keep list fails the test |
| keeps a declared field the owner edits while the create is in flight | the reset reads current state, not the submit-time snapshot |
| never mutates the object a spec hands back from `empty()` | a frozen, shared `empty()` object survives a create; without the copy the write throws |
| does not touch the bag when the create is refused | the full bag and the open form survive a refusal |
| lets a later seed win over a kept field | the keep list governs the create, not the open; a leftover field proves the bag is retained rather than rebuilt |
| re-seeds from empty on the next open when the spec keeps nothing | sale's contract |
| resets the bag and applies the seed when `resetOnOpen` is true | sale's open path |
| merges a seed into the retained bag when `resetOnOpen` is false | purchase's open path |
| lands the created item with the fields it was created from, then closes and resets | the success path |
| does not land a line when the create call refuses, and reports it | the refusal path and its message |

`apps/web/src/pages/purchase.test.tsx` (page level):

| test | what it pins |
|---|---|
| creates two items in a row from a single category pick | one pick serves both creates; the second is not refused; two distinct lines land; the quantity resets to `"1"` and the name clears; re-creating the same name replaces its line instead of appending a third |
| keeps a cleared draft cleared ... | the #146 quantity drift fix |
| keeps an unreadable or zero draft visible ... | `"abc"`, `"2.5"`, `"-3"`, `"0"` all resolve to zero and stay visible |
| sends a valid draft as a whole number ... | the money payload per line |
| keeps the unit-cost field's previous value ... | the unit-cost reader contract |
| refuses an over-cap quick-add quantity ... | the cap, client side |

`tests/e2e/purchase-intake.spec.ts` (browser level): the drift proof, unchanged
this round.

## Non-vacuity evidence

Each of these was measured by mutating the fix and re-running, not argued from
reading:

| test | mutation | result |
|---|---|---|
| creates two items in a row from a single category pick | `keepOnCreate: []` | fails: the category trigger shows `"—▼"` instead of the picked label |
| (same test, functional assertions) | `keepOnCreate: []`, trigger assertions neutralised | fails: `createdItems` has length 1, so the second create was refused |
| all five quick-add hook tests | `nextBag` ignores `keepOnCreate` | all five fail |
| keeps a declared field the owner edits while the create is in flight | reset uses the submit-time snapshot | fails |
| never mutates the object a spec hands back from `empty()` | `nextBag` does not copy | fails |

## Round 3 findings and dispositions

| # | finding | disposition |
|---|---|---|
| 1 | the cleared-kept-field test passed with the keep list emptied (vacuous) | fixed in `41c5fcd` with a non-empty default spec; now fails under that mutation |
| 2 | the `nextBag` copy was untested | fixed: the frozen-object test |
| 3 | the updater reset was untested | fixed: the mid-flight edit test |
| 4 | the constant mock id meant two creates, not two landed lines | fixed: one id per distinct name, plus a `purchase-lines` row count |
| 5 | `createdItems` was reset in only one describe | fixed: one file-level hook, cleared in place |
| 6 | purchase's non-kept fields were unpinned | fixed: the quantity and name are asserted after the first create |
| 7 | the seed-precedence test could not distinguish retained from rebuilt-and-merged | fixed: a leftover field is set first |
| 8 | a refused create must not reset the bag (unpinned invariant) | fixed: the full bag is asserted after a refusal |
| 9 | the union duplicated `empty()` and its docstring | fixed: `QuickAddBag` base type |

Not fixed, with reasons:

- The `keepOnCreate` list cannot be proven *complete* by any type or test. A
  future caller can declare `[]` and drop a field. The mitigation is the required
  declaration plus the two-items test for purchase, and the limit is recorded in
  the debate evidence.
- Purchase's `barcode`, `sellPrice`, `threshold` and `unitCost` resets remain
  structural (through `empty()`), not per-field page assertions. Adding four
  assertions would restate the bag that the hook test already compares whole.
- The duplicate-coverage note from round 2 stands: the "deterministic pin table"
  in `invoice-draft.test.ts` overlaps the three tests above it. Kept as the
  parser's regression pin.

## Gates at the evidence HEAD

| command | exit | result |
|---|---|---|
| `bun run typecheck` | 0 | `Tasks: 3 successful` |
| `bun run lint` | 0 | no findings |
| `bun run test` | 0 | `912 pass / 0 fail`, 69 files, 4716 assertions |
| `bun run test:e2e` (isolated ports) | 0 | `55 passed` (8.5m) |

Two notes, both recorded rather than hidden:

- The first two `bun run test` attempts failed on
  `SupplierOpeningBalancePage (issue 176) > counts a typed name toward the batch
  limit and blocks before the server (round 5)`. That test builds 201 suppliers;
  it takes ~54s in isolation and passed there, and the same test passed the full
  suite 20 minutes earlier. It is load-sensitive and unrelated to this delta: the
  branch does not touch that page or its test, and the only dependency it shares
  is `parseGroupedAmount`, which this branch did not modify (the diff to
  `amount-parse.ts` is additive only, zero removed lines). The third full run
  passed 912/0.
- One full `bun run test:e2e` run failed on
  `vault.spec.ts:166` (`getByTestId("vault-recovery-key")` not visible). The
  failure snapshot shows the create-vault screen with the API alert
  `VAULT_SETUP_IN_PROGRESS`, so the API refused a setup because another setup was
  in flight. The vault spec hardcodes its own ports (4399/5174), so
  `DOKAN_PORT`/`DOKAN_WEB_PORT` cannot isolate it, and three sibling lanes
  (`feat-130`, `feat-183`, `feat-184`) were running Playwright suites
  concurrently. The next full run passed 55/55, and this branch touches no vault
  file.

## Verdict

Coverage at `41c5fcd` is sound for this round: the Greptile behaviour is pinned at
hook and page level, its falsification is measured in two independent ways, the
new round-3 tests each fail under the mutation they target, and every remaining
gap is recorded with a reason.
