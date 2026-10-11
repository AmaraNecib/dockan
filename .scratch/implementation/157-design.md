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

**Web** — no new module. `ReturnsPanel` gains two derived values
(`requestedDebt`, `debtIsCapped`/`debtCapExcess`) mirroring the api's settlement
exactly; the header gains one conditional row.

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
- **Mirror drift.** The panel's projected split restates the api's arithmetic.
  It is presentation-only (the api recomputes and remains authoritative), and
  the store test pins the invariant.
- **Rejected-return asymmetry is untouched.** `cashPaidOut` is immediate while
  debt relief waits for acceptance (#68). Not changed here; needs an owner
  decision, flagged in the PR.

## Deviation log

Steps 3–5 (implement, Guard Phase 1) and 10 (push + PR) ran **before** this
document was captured: the change was implemented directly from a live
diagnosis, then this record and the lifecycle gates were completed. Steps 6–9
and 11–12 (debate, test-audit, code-review, Guard Phase 2, Greptile, Guard
Phase 3) follow in order.
