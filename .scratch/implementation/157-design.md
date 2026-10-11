# 157 — Returns settlement legibility + invoice header reconciliation

**Tier:** High-assurance (touches invoice / debt money figures exposed to the UI)
**Base:** `18a1ea67a44f42aa65e5f5e629abf1ff233cc7b3` (`origin/develop`)
**Head:** `ee7f7a46a289bd9c5cad274e50e73f051e0fccd0`
**Branch:** `fix-returns-settlement-clarity` → PR #157

## Problem

Diagnosed from the owner's live encrypted database (`INV-0002`: 2 × 12000,
discount 500 → net 23500; paid 21000; remaining 2500). A 11750 return settled as
**2500 debt + 9250 cash**, which is correct — the customer keeps one unit worth
11750 having already paid 21000, so the shop owes 9250. Every stored figure
reconciled. The *screen* implied otherwise, in three places:

1. The new-return form rendered only `المحصل في الفاتورة` = `paidAmount` (21000)
   and never `المتبقي` = `remainingAmount` (2500) — the figure the split is
   capped by (`router.ts`: `debtOffset = min(requestedDebt, remaining)`).
2. The debt cap silently redirected the excess to cash, so an "all debt" choice
   still produced cash with no explanation.
3. The header rendered total/paid/remaining only, so `INV-0001` showed
   58000 − 48000 ≠ 0 once a return had cleared 10000 of debt.

Secondarily the return-quantity input was a bare 24px box, unlabelled and
unitless, placed across the row from its item name.

## Interfaces

**Contract** (`packages/contracts/src/core.ts`) — `invoiceDetailSchema` gains:

```ts
returnCreditAmount: z.number().int().min(0)   // sum of the invoice's returns.debtApplied
```

Invariant it exists to express: `totalAmount − paidAmount − returnCreditAmount === remainingAmount`.
No new procedure, no input change, no migration.

**Store** (`StorePort.getInvoiceDetail`) — one extra aggregate select in the
existing `Promise.all`; `debtApplied` already encodes "actually relieved" (0 for
pending per #68 and for rejected returns), so no status filter is needed.

**Shared math** (`packages/contracts/src/return-refund.ts`) — moved out of the api:
`refundUnitPriceFor`, `lineRefundAmount`, `computeReturnRefund` and their types.
The api file re-exports them so existing callers/tests keep their import path.

The panel now calls the SAME `computeReturnRefund` the api prices with, feeding
it a `prior` map built from the returns list (every status, matching
`StorePort.returnedByLine`). A client-side restatement previously drifted on the
COMPLETING return — net 101 over 3 units refunds 34 then 67, never
34 + 34 = 68 — so the owner was promised 1 DZD more cash than the server would
settle. One implementation, two callers, nothing left to drift.

**Web** — no new module. `ReturnsPanel` derives `priorByLine`, `valueTotal`
(via `computeReturnRefund`), `requestedDebt`, `projectionIsValid`,
`projectedDebt`, `settledCash`, `debtIsCapped`; the header gains one
conditional row. Money figures render through `Amount` for LTR isolation.

**New i18n keys:** `invoiceReturnsCredit`, `returnsRemainingDebt`,
`returnsCashToCustomer`, `returnsDebtCapNote`, `returnsSettlementSummary`,
`returnsUnitPiece`, `returnsNothingLeft`.

**New test ids:** `invoice-returns-credit`, `returns-remaining-debt`,
`returns-debt-offset`, `returns-debt-cap-note`.

## Dependencies

None added. Uses the existing `returns` table/column, the existing i18n
catalogue, and existing Tailwind theme tokens.

## Planned tests

*Unit (bun):* remaining-debt row renders; cap note present when
`remaining < requestedDebt` and absent otherwise; the split figures equal the
api's `min(requestedDebt, remaining)`; the quantity field is labelled; the
sold-out message replaces a dead field; the header credit row present/absent;
store test asserting `returnCreditAmount` sums only relieved debt and preserves
the reconciliation invariant.

*E2E (Playwright, `tests/e2e/returns.spec.ts`):* 1 × 900 sale with a 200 down
payment → remaining 700; the panel shows remaining 700 beside value 900; an
all-debt split reports 700 debt + 200 cash plus the cap note; after acceptance
the invoice header shows `خصم المرتجعات 700` and remaining 0.

## Risks

- **Contract widening.** `returnCreditAmount` is required, so every
  `InvoiceDetail` literal must supply it (2 router sites, 1 store, 3 test
  fixtures). Compile-time only; the typechecker enumerates them.
- **Mirror drift — resolved, was a risk.** The first revision restated the api's
  arithmetic client-side; review proved it drifted on the completing return.
  The math now lives in `packages/contracts` and both sides call it, so there is
  no second implementation left to drift. Pinned by a 101/3 preview test.
- **Legacy pre-#68 rows — verified absent, documented.** The header term sums
  `returns.debtApplied`, which is 0 for a return whose debt was relieved at
  creation by a pre-#68 build. Verified against the owner's live vault: 0
  ACCEPTED rows with `debtApplied = 0`, 0 with `debtApplied < debtOffset`, 0
  non-accepted rows with `debtApplied > 0`, and 0 invoices where
  `remaining ≠ total − paid − ΣdebtApplied`. This vault is a fresh install, so
  the case is unreachable here; a backfill would be needed if data predating #68
  ever appears (deferred follow-up).
- **Rejected-return asymmetry is untouched.** `cashPaidOut` is immediate while
  debt relief waits for acceptance (#68). Not changed here; needs an owner
  decision, flagged in the PR.
- **Pending-return promise.** Two pending returns can each promise the whole
  debt; only the first acceptance relieves it. Pre-existing api behaviour, and
  `returnsDebtAppliesOnAccept` already tells the owner relief is deferred, but
  the residual is written down rather than silently accepted.

## Review round 1 — dispositions (HEAD 2a47436e → fixes at the commit below)

Seven read-only lanes (debate critic + defender, test-audit 3 lenses,
code-review Standards + Spec) plus Greptile 4/5.

**Fixed**

1. Cap note showed the excess over the typed cash while the cash row showed the
   total → two figures for one amount (Greptile P2 #1). Note now names
   `settledCash`, and the test pins parameter ORDER.
2. Preview was not sequence-aware (Greptile P2 #2, critic #2, standards #3) →
   shared `computeReturnRefund`; 101/3 test added.
3. e2e `toContainText("0")` also matched "700" — the assertion could not fail
   for the bug it targeted (test-quality, blocker) → `toHaveText(/^0\b/)` etc.
4. The split rendered for an invalid custom draft → `NaN`/negative figures on
   screen (edge-hunter, critic #9, spec note) → gated on `projectionIsValid`.
5. Store test could not tell `sum(debtApplied)` from `sum(debtOffset)`, did not
   aggregate, and did not prove invoice isolation (test-quality, coverage,
   edge-hunter) → PENDING row with a non-zero promise, a second accepted
   return, and a cross-invoice case added.
6. Header fixture had credit = remaining = 100, so a row bound to the wrong
   field passed (test-quality) → distinct 150/50 + exact `toBe` assertions.
7. Panel money figures bypassed `Amount` (standards #1) → routed through it.
8. Boundaries added: zero debt, return exactly equal to the debt, the custom
   split's rendered arithmetic, and the field's forced-cash floor.
9. Arabic literal in an `invoice.tsx` code comment broke the locale-neutral
   guard → rewritten.

**Dismissed (with reason)**

- Critic #8 scope sprawl in the quantity restyle: the restyle is the owner's
  explicit request, not incidental.
- Critic #10 minus sign on the credit row: the label is
  `خصم المرتجعات` (returns deduction); the value is unsigned by contract.
- Critic #5 clamped-remaining fixtures: `applyPaymentToInvoice` refuses
  overpayment and returns cap at remaining, so the clamp is defensive only.

**Deferred (owner decision)**

- Rejected-return cash asymmetry, and a rejected return keeping `cashPaidOut`
  while `debtApplied` stays 0. Documented in the PR body.

## Deviation log

Steps 3–5 (implement, Guard Phase 1) and 10 (push + PR) ran **before** this
document was captured: the change was implemented directly from a live
diagnosis, then this record and the lifecycle gates were completed. Steps 6–9
and 11–12 (debate, test-audit, code-review, Guard Phase 2, Greptile, Guard
Phase 3) follow in order.
