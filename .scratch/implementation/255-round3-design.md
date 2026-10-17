# #255 round 3 — Greptile fix round (PR #264, head 12e258da)

Base: `feat-255-bulk-add-row` (continue the PR branch; not `develop`).
Tier: **Standard** — a fix round on an existing PR whose diff is UI code, a
read-only server query and tests. It does not touch stock quantity, payment
totals, debt direction, auth/RBAC/secrets or backup/restore, so none of the five
High-assurance failure modes can be violated.

Authority: commit only. No push, no PR, no merge, no `.agents/wisdom/`.

## Findings and the fix for each

### Finding 1 — e2e "ONE request" assertion counts nothing (`tests/e2e/supplier-adjustment.spec.ts:146`)

`page.waitForResponse` resolves on the FIRST matching response, so a second
opening-balance POST in the same save is invisible to the `created` check.
Fix: record every matching request in a `page.on("request")` handler for the
duration of the save and assert `toHaveLength(1)` after the saved card renders.
The request event fires at send time, so a duplicate that is issued but never
answered is still counted.

### Finding 2 — a name with no identity escapes the duplicate checks (`apps/web/src/lib/supplier-opening-draft.ts:100`)

`newOpeningRowStatus` gates the name on `name.trim()`, but `"\u200f"` (RLM) and
`"\u061c"` (ALM) are Unicode `Cf`, not whitespace, so `trim()` keeps them. They
fold to `""` under `normalizeTextKey`, and `duplicateTypedRowIds` skips empty
keys, so the row is `filled`, Save stays enabled, and the api normalizes the
whole batch to one empty key and refuses it with
`DUPLICATE_OPENING_BALANCE_ROW` (router.ts `newNames` set) — every amount lost.
Fix: make the name gate the identity key, not the raw string. A name that folds
to `""` with no amount is `untouched`; with an amount it is `incomplete`, which
the page already surfaces per row and blocks on. `duplicateTypedRowIds` keeps its
empty-key skip as the last defence for a row that never became ready.

### Finding 3 — a 200-row save issues 200 full resolve reads (`apps/web/src/pages/supplier-opening-balance.tsx:468`)

The page calls `suppliersResolveName` once per typed row; each call rereads
`listPartyNames` and recomputes `listSupplierAccountSummaries`. Fix: add a batch
`suppliersResolveNames` procedure. One handler reads the two lean lists ONCE,
builds a `normalizeTextKey → candidates` map, then resolves each row's signature
separately through the same `resolveOpeningDestination`. `suppliersResolveName`
(single) is reimplemented on the same helper so the rule still lives in exactly
one place and its #213 lean-read tests keep covering it. The page calls the batch
once per submit; row order maps results back by index.

### Finding 4 — mixed confirmation answers lack coverage (`apps/web/src/pages/supplier-opening-balance.test.tsx:2045`)

The multi-row save tests resolve every typed name to `null`; the confirmation
tests use one typed row. A per-row destination map that crossed two rows'
answers would pass. Fix: one test with a typed row that resolves to an existing
supplier that carries entries and a typed row that resolves to `null`; assert no
write before confirmation, then each row's own `expectedSupplierId`,
`confirmExisting` and amount. Proven non-vacuous by a mutation that swaps the
per-row destination lookup (see the evidence below).

### Also closed (named in the review summary, not in this round's detailed list)

- Per-item amounts in the e2e saved card (summary finding 4): a list item is
  located by its supplier name and the amount is asserted inside that item.
- Focus fallback after removing the last typed row (summary finding 6):
  `focusByTestId` already reports whether focus moved; when the add control is
  disabled (200 filled rows at the cap) focus falls back to the Save control.

## Interfaces

```
suppliersResolveNames(input: {
  occurredAt: localDateTime,
  reason?: string | null,
  rows: Array<{ name, direction, amount }>   // 1..200
}) -> { suppliers: Array<{ id, name, accountEntryCount } | null> }  // parallel to rows
```

## Risks

- The batch query key changes with every row edit, so a cached answer is used
  only for the exact batch it answered for — the same property the per-row keys
  had. The page still tags the snapshot with `resolveKey`.
- `resolveTypedDestinations` is called from the refusal-recovery path too; it
  must tolerate an empty `typedLookups` (rows cleared while the dialog was
  open) and return `{}` rather than read `typedLookups[0]`.

## Planned tests

- `apps/web/src/lib/supplier-opening-draft.test.ts`: mark-only name with an
  amount is not a ready row.
- `apps/web/src/pages/supplier-opening-balance.test.tsx`: the page blocks that
  row; the mixed-confirmation test; the batch resolve is one call per save.
- `apps/api/src/rpc/router.test.ts`: the batch resolve performs the two lean
  reads once for N rows and answers each row identically to the single
  procedure.
- `tests/e2e/supplier-adjustment.spec.ts`: exactly one opening-balance request
  per save; each saved list item carries its own amount.

## Round 4 — audit of the rescued commit `5039a4e` (this lane)

Tier: **Standard**, unchanged. The reason is the same as above and the round-4 diff
is smaller than round 3's: UI validation, a read-only batch query and tests. It
touches no stock quantity, payment total, debt direction, auth/RBAC/secret or
backup/restore path.

### Base

The rescued work sat on `da4ee22`, one commit behind the PR head. `12e258da` was
NOT an ancestor, so the tree could not be pushed as-is. This lane **rebased**
`5039a4e` onto `12e258da` (not merged), then squashed the result with the audit
fixes below into one commit, so no commit in the branch carries the duplicate
write the rescue introduced.

Three files conflicted, because `12e258da` independently fixed the same two
findings the rescue had touched. Resolutions:

- `supplier-opening-balance.tsx` — took the **HEAD** focus effect (fall back
  through Save, then Cancel, then the back link). The rescue's Save-only fallback
  is a subset; HEAD's is strictly stronger and its mutation evidence already
  exists at `12e258da`.
- `tests/e2e/supplier-adjustment.spec.ts` — took **HEAD** on both hunks: the
  `openingRequests` counter and the `opening-balance-saved-row` exact-name row
  scoping. The rescue's variants proved the same thing (`openingWrites.count`,
  `getByRole("listitem")`); keeping both would be two pins for one fact. The
  rescue's endpoint rename (`suppliersResolveName` → `suppliersResolveNames`)
  kept, since the page now calls the batch endpoint.
- `supplier-opening-balance.test.tsx` — kept **both**: HEAD's cap-focus test and
  the rescue's three new tests (findings 2, 3, 4).

### Kept, changed, deleted from `5039a4e`

| Piece of the rescue | Verdict | Reason |
| --- | --- | --- |
| `suppliersResolveNames` contract + handler + `resolveOpeningNames` | **kept** | Finding 3's fix; the two lean reads happen once per batch. Verified by ablation. |
| Single `suppliersResolveName` reimplemented on the shared helper | **kept** | The rule stays in one place; the #213 lean-read tests keep covering the single path. |
| Page `resolveTypedDestinations` one batch `fetchQuery` | **kept** | Finding 3's fix; `resolveCalls === 1` proved by mutation. |
| `newOpeningRowStatus` identity gate (`folded === ""`) | **kept** | Finding 2's fix; red before, green after. |
| `blankness-ratchet.test.ts` entry removal | **kept** | The raw `name === ""` gate is gone on purpose, so its raw verdict no longer exists. Ratchet green. |
| Finding 4 mixed-batch test | **kept** | Red under a crossed-destination mutant. |
| **Duplicate `await save(false, destinations)` in `submit`** | **deleted** | A real bug: the no-confirmation path issued TWO `suppliersOpeningBalances` POSTs. Found by reading the rescue diff, not by a test. The surviving e2e request-count pin fails against it (see evidence). |
| Rescue's extra cap-focus test ("falls back to Save … finding 6") | **deleted** | Duplicate coverage: HEAD's cap test asserts the same active control plus a positive control. Focus was a round-2 finding, not one of this round's four. |
| Rescue's e2e request-counter and list-item variants | **deleted** | Superseded by HEAD's equivalents (above). |

### What was NOT re-verified as "already there"

Finding 1 (`r4302427456`, "Extra requests pass the test") is **already closed at
`12e258da`** — the same discussion id — by `expect(openingRequests).toHaveLength(1)`.
Per `docs/engineering-workflow.md` ("verify every finding against the code before
fixing it") this lane re-ran the assertion against a real duplicate write rather
than trusting the commit message: see the evidence file.

