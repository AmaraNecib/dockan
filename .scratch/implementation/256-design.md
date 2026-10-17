# Issue #256 — default the refund to the party's debt, cash only when there is none

Branch: `feat/256-return-defaults`, base `d843566` (merge-base with `origin/develop`).

## 1. Review tier

**High-assurance** — failure mode (3): the change decides which money path a refund takes
("debt direction / who owes whom"). A wrong default silently leaves or removes a debt the
owner cannot see. Standard gates plus `debate`.

## 2. What exists today

- Customer return (`returnsCreate`): the owner picks a split. `cashPaidOut` is sent when the
  owner chooses anything but the all-cash preset; absent `cashPaidOut` means **all cash**
  (`requestedCash = input.cashPaidOut ?? refundTotal`), and the debt portion is capped at the
  invoice's remaining debt with the excess flowing back to cash.
- Supplier return (`suppliersReturn`): `cashBack` absent means **no cash back** — the value
  reduces the linked invoice's remaining and/or becomes account credit (`supplierReturnSplit`,
  #161).
- So both sides default to the *opposite* of the owner's rule: the customer defaults to cash
  even when he owes, and the supplier defaults to "no cash" even when nothing is owed.

## 3. Decision (the default only)

A shared pure decision, `returnSettlementDefault({ returnValue, invoiceDebt, partyDebt })`,
lives in `packages/contracts/src/return-refund.ts` (the module the api and the web already
share for the refund arithmetic):

| condition | default |
| --- | --- |
| `returnValue <= invoiceDebt` | `DEBT` — the whole return reduces this invoice's debt |
| `partyDebt === 0` | `CASH` — no debt anywhere |
| otherwise | `UNDECIDED` — the debt cannot absorb the return here |

`UNDECIDED` splits into two reasons: `EXCEEDS_DEBT` (0 < invoiceDebt < returnValue) and
`DEBT_ELSEWHERE` (invoiceDebt 0, debt on other invoices). Both **refuse** the default at the
api (`RETURN_EXCEEDS_DEBT` / `RETURN_DEBT_ELSEWHERE`) and block the form with a message that
names the numbers — the owner decides the method explicitly.

Supplier side: the default is `cashBack = 0` while the shop owes the supplier
(`supplierBalance > 0`), and `cashBack = returnValue` when nothing is owed either way. Same
law, expressed on the signed account.

### Scope guard compliance

- Implemented: debt-first default for both sides; cash only when there is no debt.
- **Refused, not guessed:** the case where the return exceeds the debt. The default path
  refuses instead of inventing a split.
- **Refused, still open:** applying the return to a debt on *another* invoice (the decision
  table's row 2, "confirm which"). Any allocation across invoices would have to break the
  single-invoice reconciliation the invoice header relies on
  (`totalAmount − paidAmount − returnCreditAmount = remainingAmount`) and needs the owner's
  oldest/newest answer. Until then the default refuses with a distinct message
  (`RETURN_DEBT_ELSEWHERE`) and the owner can still choose cash or a custom split by hand.
- **Unchanged:** an explicit split (`cashPaidOut` present, or a typed `cashBack`) keeps
  today's semantics exactly, including #162's warned debt cap ("all debt" capped at the
  remaining, the rest to cash). The refusal is about the app choosing for the owner; the
  owner may still choose the cap-aware split, visibly and before saving.

### Why the supplier's excess-over-debt path is not refused

A purchase return larger than what we owe settles as account credit — the signed ledger's
own arithmetic (#161, pinned by tests), not a cash guess. The owner's cash-back field is the
explicit override. Refusing it would regress an approved behaviour on a question the guard
did not open; it is reported to the owner instead.

## 4. Interfaces

- `packages/contracts/src/return-refund.ts` — `returnSettlementDefault(input)`,
  `ReturnSettlementDefault`, `ReturnSettlementDefaultReason`. Pure, no IO.
- `apps/api/src/lib/return-calculations.ts` — re-export (existing pattern).
- `apps/api/src/rpc/router.ts` — `returnsCreate` uses the decision when `cashPaidOut` is
  absent; `suppliersReturn` uses the balance when `cashBack` is absent. Two new i18n error
  keys. No schema change, no migration.
- `apps/web/src/pages/invoice.tsx` — the settlement select starts at the derived default
  (`ALL_DEBT` / `ALL_CASH` / unset-until-chosen), re-derives while untouched, and blocks
  submit with the refusal copy. The party-debt read is `debtsByParty` (same store seam the
  api uses), so the panel's default and the api's default read the same rows.
- `apps/web/src/components/parties/supplier-return-panel.tsx` — takes the account `balance`
  and shows the derived default beside the cash-back field.

## 5. Tests (TDD, red first)

- Unit (`apps/api/src/lib/return-calculations.test.ts`): the decision table — no debt → CASH;
  debt ≥ return → DEBT; debt < return → UNDECIDED/EXCEEDS_DEBT; debt elsewhere → UNDECIDED/
  DEBT_ELSEWHERE; unresolved party read → UNRESOLVED.
- API (`apps/api/src/rpc/router.test.ts`): the three acceptance cases on `returnsCreate`,
  the two refusals, the explicit-split path unchanged, and the supplier default both ways.
- Web (`apps/web/src/pages/invoice-returns.test.tsx`,
  `apps/web/src/components/parties/supplier-return-panel.test.tsx`): the pre-selected method,
  the refusal copy, the explicit override payloads, the supplier default note.
- E2E (`tests/e2e/returns.spec.ts`): the flipped default end to end (voucher cash 0 / debt
  full), plus the supplier default note.

## 6. Risks

- The default flips: a counter owner who records a return on a debt-carrying invoice now
  promises a debt offset instead of cash. That is the ticket; the split select and the
  projection rows keep it visible, and the explicit presets still exist.
- `UNDECIDED` refuses a return the owner could previously save with the default. The message
  names the numbers and the override, so the block is actionable.
- Duplicated decision inputs (web preview, api write) — mitigated by one shared pure function
  and by sending the explicit amount only when the owner has touched the control.
