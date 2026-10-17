# #257 review round 3 — the stale invoice-number expectation in the PR's e2e

**Tier:** standard.
**Justification:** the diff is an e2e expectation in `tests/e2e/` — reviewable
test code, but it can violate none of the five High-assurance failure modes
(no stock arithmetic, no money computation, no debt direction, no auth/RBAC,
no backup/restore). Standard gates apply: guard 1 → test-audit → code-review →
guard 2.

**Base:** `feat-257-inline-product` (PR #266). The lane branch carries
`origin/feat-257-inline-product` (`a6838f0`) and merges `origin/develop`
(`03d1878`) so the tree actually contains #268 — the invoice-number kind prefix.

## The defect

`tests/e2e/purchase-inline-product.spec.ts` asserts the pre-#268 shape:

- line 94: `toContainText("INV-")` after saving a purchase (test at line 14)
- line 182: `toContainText("INV-")` after saving a purchase (test at line 123)

`#268` (`bbdd005`, merged into `develop`) gave every invoice kind its own prefix
and its own counter. The merged code:

- `apps/api/src/store/drizzle-store.ts:1848` `allocateInvoiceNumber(kind)` takes
  the prefix from `invoiceNumberPrefixFor(kind)`;
- `apps/api/src/lib/document-number.ts:12-13` `invoiceNumberPrefixes` maps
  `SALE → "INV"`, `PURCHASE → "SUP"` (a `satisfies Record<InvoiceKind, string>`
  guard);
- `apps/api/src/rpc/router.ts:1324` a purchase create calls
  `allocateInvoiceNumber("PURCHASE")`, so a purchase is numbered `SUP-NNNN`.

There is no assumption in this design: the prefix comes from the router call
site, not from the ticket's prose.

## The change

Replace both `toContainText("INV-")` assertions with `toContainText(/SUP-\d+/)`.

Why the regex and not the plain `"SUP-"` string: the acceptance criterion says
the spec must still fail if the purchase number lost its prefix entirely, and
must not pass on "some text appeared". `SUP-\d+` pins the prefix **and** the
digit body, so a prefix-less `0031` (or a bare `SUP-` with no number) fails it.
This matches the shape assertions #268 itself left in the other purchase specs
(`purchase-intake.spec.ts:93` string + `:99` regex, `supplier-account.spec.ts:52`
string + `:54` regex, …).

## Sweep — other `INV-` expectations on a purchase or return path

Measured at the pre-fix tree `da5f336`: `git grep -n "INV-" da5f336 -- tests/e2e`
returns **36 lines** = 30 non-comment + 6 comments. Of those, the two
`purchase-inline-product.spec.ts` assertions (`:94`, `:182`) and one stale
comment (`supplier-adjustment.spec.ts:101`) are purchase-path; the other 33 are
sale-path (a sale correctly keeps `INV-`: `sale-saved-number`, the sale receipt,
and the customer's unpaid **sale** invoice table). After the fix the same grep
returns 34 lines: the 33 sale-path ones plus the new explanatory comment in
`purchase-inline-product.spec.ts:95`.

| file:line | subject | verdict |
|---|---|---|
| `purchase-inline-product.spec.ts:94,182` | `purchase-saved-number` | **fix → `SUP-\d+`** |
| `supplier-adjustment.spec.ts:101` | comment above a `SUP-` assertion | **fix comment (stale text)** |
| `debts.spec.ts:120` | a customer's unpaid **sale** invoices | keep `INV-` |
| `customers.spec.ts:246,306`, `receipts.spec.ts:92`, `returns.spec.ts`, `sale-checkout.spec.ts`, `00-onboarding.spec.ts`, `96-returns-supplier-action.spec.ts`, `completion-screens.spec.ts`, `expense-reports.spec.ts`, `invoice-payments.spec.ts`, `learnability.spec.ts` | sales / sale receipts | keep `INV-` |

No `RTN-` expectation remains anywhere in `tests/e2e/` (#268 converted the
customer-return ones to `RET-`).

## Tests / evidence plan

- Failing-first: `npx playwright test tests/e2e/purchase-inline-product.spec.ts`
  on the merged tree **before** the fix → red, `SUP-0031` vs `INV-` at `:94`.
- Green: the same command after the fix → 2 passed.
- Ablation A: `formatDocumentNumber` returns the digits with no prefix → the
  spec fails, proving the assertion is not vacuous.
- Ablation B: `PURCHASE: "SUP"` → `"INV"` → the spec fails, proving it names
  this kind's prefix and not any three letters.
- Also re-run the purchase-path neighbours on the same slot
  (`purchase-intake`, `supplier-account`, `stock-ledger`) to prove the fix is
  not masking a real regression in the line-create flow.
- `bun run typecheck` / `bun run lint` exit codes.

## Risks

1. The suite shares one database, so a spec that leaves a purchase unpaid can
   move a later spec's numbers. Both tests here save their own invoice and read
   only shape, not an absolute sequence.
2. The lane's local run must use an `e2e-slot.sh` slot; a sibling lane on the
   shared ports would produce the "different spec set fails each run" smell
   (`.agents/wisdom/2026-10-15-concurrent-lane-e2e-ports.md`).
3. Merging `develop` could have moved other expectations in this file; the
   sweep above is the answer, and the merge was conflict-free.
