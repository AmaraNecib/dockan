# #238 — test-audit evidence (High-assurance)

- Base: `origin/develop` @ `2c8d867`. Reviewed HEAD: `7190e73`. Final HEAD: `09abea2`.
- Lenses: three independent review sub-agents (edge-case hunter, coverage analyst,
  test-quality reviewer), read-only.
- Sources: `apps/web/src/lib/draft-blankness.test.ts`, the changed pins in
  `amount-parse.test.ts` / `invoice-draft.test.ts`, `tests/e2e/sale-checkout.spec.ts`.

## Coverage — requirement → test

| Brief requirement | Test | Status |
|---|---|---|
| Item 1: all four sites, one table (empty / mark-only / digit) | `draft-blankness.test.ts` `SITES` table (6 rows incl. `draftBlank`) | ✅ |
| Item 1: mark-only judged same as blank everywhere | invariant test + whole-set loop | ✅ |
| Item 2: drive `PASTED_BIDI_MARKS`, not one char | whole-set loop over bare/wrapped/doubled, now plus mixed-pair and edge-with-digits | ✅ |
| Item 2: extended/interior cases | interior driven over the whole mark set; edge-with-digits uses both Arabic-Indic scripts | ✅ (was partial → strengthened) |
| Item 3: interior mark stays a refusal | per-mark interior test at `draftBlank`, `percentageDraftInvalid`, `resolveInitialPaid`, `nextUnitCost`, `saleOverrideInvalid`, `saleUnitPrice` | ✅ (was RLM-only → strengthened) |
| Unify the predicate, not the fallback | predicate shared; each fallback preserved | ✅ |
| `draftBlank` beside the normaliser | `amount-parse.ts`, imported by `invoice-draft.ts` | ✅ |
| E2E on the invoice/sale commit path | `sale-checkout.spec.ts` mark-only amount and percentage, asserting `sale-saved-debt = 1000` | ✅ |
| Failing test first | captured in the crew report: import red, then behavioural red on `percentageDraftInvalid` | ⚠️ process evidence lives in the crew report, not the tree |

## Findings

**Edge-case hunter (all behaviours now correct unless noted):**
- LRO/RLO-only drafts (`\u202d`/`\u202e`) are *not* blank → **intended refusal**, not a gap: #227 excludes the
  directional overrides because a forced-display-order run can differ from its logical digits. They are refused
  (`percentageDraftInvalid` true, `resolveInitialPaid` `{ok:false}`, `nextUnitCost` keeps previous). Documented;
  no change.
- Mixed *different* marks — **added** (was same-mark-doubled only).
- Interior refusal pinned with RLM only, omitting `saleUnitPrice` — **added** per-mark + `saleUnitPrice`.
- Mark + grouping separator / mark + sign read as content — **intended** (a separator/sign is content); stated in
  comments via the edge-with-digits test; the design notes the boundary. No pin added.
- Overflow with a mark — already covered by the #227 reader pins; not duplicated here.
- Non-table sites (`parseQuantityDraft`, `discountAmountFor`, `nextPaymentPair`) — already have #227 RLM pins and
  are equivalent by construction (`parseQuantityDraft` inlines the same normalise+trim). Deferred as named.

**Coverage analyst:**
- `saleDebt` (`sale.tsx:69`) was a fifth raw-trim opinion on the exact sale path; **fixed** and pinned in
  `sale.test.tsx`.
- Two settle-panel amount guards, `resolveOpeningStock`, `supplier-opening-draft.ts`, the clamp — **deferred**,
  named in the design and docstring.
- `percentageDraftInvalid`'s `SITES` row has `blankVerdict === chosenVerdict`; **fixed** with discriminating
  negatives (`"12.5"`, `"abc"`, `"101"` → true).

**Test-quality reviewer (grade B+):**
- The table genuinely drives the exported list (verified). ✅
- `nextUnitCost` row cannot discriminate the new branch — accepted; ablation recorded below.
- Redundant/tautological assertions — removed the `.trim()` platform assertion; kept the explicit invariant test
  as executable documentation.
- e2e setup duplication — accepted (matches the existing spec's inline pattern; `saveQuickAdd` is the shared helper).

## Mutation / ablation proof (exact commands)

All run from `apps/web`, base/final HEAD `09abea2` unless stated.

1. **Real behaviour fixes red (the class test detects them).** Reverted `percentageDraftInvalid` to
   `draft.trim() !== ""` and `resolveInitialPaid` to `amountDraft.trim() === ""`; ran
   `bun test src/lib/draft-blankness.test.ts` → **4 pass / 3 fail, exit 1** (failures: the site-verdict table,
   the class invariant, the whole-set loop). Restored; re-ran → 7 pass / 0 fail.
2. **`nextUnitCost` ablation (honest — the branch is reason-only).** Deleted `if (draftBlank(value)) return 0;`;
   ran `bun test src/lib/draft-blankness.test.ts` → **7 pass / 0 fail, exit 0**. The branch changes no reachable
   input's result; it is kept to pin the cleared-field→0 contract against a future reader change, and this file
   does not claim otherwise.
3. **`saleDebt` fix red.** Reverted `saleDebt` to `paidDraft.trim() === ""`; ran `bun test src/pages/sale.test.tsx`
   → **58 pass / 1 fail, exit 1** (`treats an empty or zero paid draft as the whole total becoming debt`).
   Restored; re-ran → green.

## Gate results at final HEAD `09abea2`

- `bun run typecheck` → exit 0 (4/4 packages).
- `bun run lint` → exit 0.
- `cd apps/web && bun test --max-concurrency=2` → **1157 pass / 0 fail, exit 0** (73 files).
- `DOKAN_PORT=4517 DOKAN_WEB_PORT=5373 bun run test:e2e tests/e2e/sale-checkout.spec.ts` → **6 passed, exit 0**
  (includes the new mark-only payment test). `.dokan-port` restored after the run.
