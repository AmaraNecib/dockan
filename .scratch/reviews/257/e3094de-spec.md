# SPEC axis — e3094de (feat-257-inline-product-round3)

Read-only review: `git show`/`git diff`/`git grep`/`sed` plus reading existing logs. **I ran no tests, typecheck, lint or e2e browser run.**

## Correct

- (4) Tree carries #268: `bbdd005` is an ancestor of both `da5f336` and `e3094de`.
- (1) Prefix matches the code. `apps/api/src/lib/document-number.ts:12-13` maps `SALE: "INV"`, `PURCHASE: "SUP"` under `satisfies Record<InvoiceKind, string>` (`:14`); `apps/api/src/rpc/router.ts:1324` calls `allocateInvoiceNumber("PURCHASE")`; `apps/api/src/store/drizzle-store.ts:1848` takes the prefix from `invoiceNumberPrefixFor(kind)`. A purchase is `SUP-NNNN`, so the assertion is right.
- (2) Meaningful: `tests/e2e/purchase-inline-product.spec.ts:97,185` use `/SUP-\d+/`, not "some text".
- (5) Ablations in `.scratch/reviews/257/ablation-A1.log` (prefix stripped → received `0001`) and `A2.log` (`PURCHASE`→INV → received `INV-0001`) show it bites.
- (6) Green with counts: `pre-commit-e2e-green.log` ends `18 passed (3.7m)`; red-first `pre-fix-e2e-red.log` shows `2 failed`, received `SUP-0001`/`SUP-0002`.
- (3) Sweep conclusion holds: every remaining `INV-` line is a sale path (`sale-saved-number`, sale receipts, `debts.spec.ts:120` = the customer's unpaid SALE invoices). Supplier returns mint `PRT-` in SQL (`drizzle-store.ts:2192`), unchanged by #268; no e2e assertion breaks on a purchase or return path.

## Missing / partial

- None blocking. Brief evidence "statement of whether the rebase changed any other expectation, with the search you ran" is present in the commit body + design doc.

## Scope creep

- `tests/e2e/supplier-adjustment.spec.ts:101` comment reword only. Justified by the brief's step 3 sweep; no assertion touched. Acceptable, but it is the one change outside `purchase-inline-product.spec.ts`.

## Implemented but inaccurate

- Design doc sweep counts are wrong: it says `rg -n "INV-" tests/e2e/` → "33 hits… 31 are sale-saved-number" (and 31+4 rows = 35, self-contradictory). Actual at `da5f336`: **36** lines = 33 sale-path + 2 purchase assertions + 1 stale comment. Verdicts per row are correct; the numbers are not.
- Design doc "the other eleven specs (purchase-intake.spec.ts:93, supplier-account.spec.ts:52)" cite lines asserting the bare string `"SUP-"`; the shape regexes are at `:99`/`:54`.
- Design/commit cite `document-number.ts:8-12`; on the merged tree the map is `:12-13`.
- `.scratch` evidence is untracked (`git status`), outside the commit — consistent with the brief's "commit only".

Next: correct the "33 hits" figure to 36/33 in `.scratch/implementation/257-round3-design.md`.
