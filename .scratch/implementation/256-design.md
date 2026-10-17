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

---

# Round 2 — the approved policy (owner decision record)

Tier unchanged: **High-assurance** — the change still decides which money path a refund takes
(failure mode 3, "debt direction / who owes whom"), and it now also writes debt against more
than one invoice, which touches failure mode 2 (an invoice total computed wrongly, i.e. the
header reconciliation `totalAmount − paidAmount − returnCreditAmount = remainingAmount`).
Standard gates plus a self-critique standing in for the debate step (the lane does not
delegate; the brief forbids `subagent`).

## 7. What the owner decided (`.scratch/notes/decisions-money-ar.html`)

| question | answer | built as |
| --- | --- | --- |
| return larger than the debt | **split** — clear the tab to zero, hand the rest back as cash | `SPLIT` default (`debtOffset = tab`, `cash = value − tab`) |
| the debt is on another invoice | **allocate** across the party's open invoices | acceptance relieves the party's open invoices, **oldest first** |
| supplier return larger than the debt | keep the excess as account credit | unchanged (#161 ledger arithmetic) |

Round 1's `UNDECIDED` / `RETURN_EXCEEDS_DEBT` / `RETURN_DEBT_ELSEWHERE` refusals are gone:
both questions they refused are answered.

## 8. Interfaces (deltas)

- `packages/contracts/src/return-refund.ts`
  - `returnSettlementDefault({ returnValue, invoiceDebt, partyDebt })` →
    `DEBT | SPLIT{debtOffset, cashPaidOut} | CASH | UNRESOLVED`. The bound is `max(invoiceDebt,
    partyDebt)` — the party's tab, which the owner called "this invoice or another invoice".
  - `derivedRefundSplit(settlement, returnValue)` → the two stored numbers (or `null` while the
    party read is unresolved).
  - `explicitRefundSplit({ returnValue, cashPaidOut, invoiceDebt })` → the owner's explicit
    choice, #162 cap included. One implementation, so the api's write and the web's preview
    cannot drift (round 1 restated the formula by hand in `invoice.tsx`).
  - `compareInvoicesOldestFirst` / `sortInvoicesOldestFirst` → the ordering the payment panel
    already applies (#164), moved next to the refund arithmetic because acceptance now needs the
    same rule; `party-settle.ts` calls it instead of its own copy.
- `apps/api/src/db/schema.ts` — new append-only `return_debt_applications`
  (`return_id`, `invoice_id`, `amount`, `created_at`): the per-invoice attribution of an accepted
  offset. `CURRENT_SCHEMA_VERSION` → **5** (a v4 build derives the credit from
  `SUM(returns.debt_applied)` on one invoice and would print a header that does not reconcile).
- `apps/api/src/store/*` — `insertReturnDebtApplication`; `getInvoiceDetail.returnCreditAmount`
  = the attribution rows for that invoice, **plus** the legacy `returns.debt_applied` for a
  return that has no rows at all (so a database missing the backfill reports what the old formula
  reported); `backfillReturnDebtApplications` (marker `migration.returnDebtApplicationsV1`,
  deterministic ids, `NOT EXISTS`-guarded) attributes every already-applied offset to the
  invoice it relieved.
- `apps/api/src/rpc/router.ts` — `returnsCreate` maps the derived default (or the explicit
  choice) to `debtOffset` / `cashPaidOut`; `returnsAccept` relieves the return's own invoice
  first, then the party's other open invoices oldest-first, and writes one attribution row per
  invoice in the same unit.
- `apps/web/src/pages/invoice.tsx` — the derived method pre-selects (a SPLIT opens on the custom
  cash pair, pre-filled with the remainder), the panel shows the party's whole tab when it is not
  on this invoice, and an untouched form still sends `cashPaidOut` ABSENT so the server derives
  the split from fresh debt. `returns-debt-confirm` survives as "go back to the derived default".

## 9. The one judgement call

**The return's own invoice is relieved before the party's older invoices.** The brief fixes the
*ordering* question (oldest-first, the payment panel's convention) but not this one, and it is a
consequence of "an explicit owner choice stays untouched": an explicit `cashPaidOut` is capped at
this invoice's remaining debt at creation, so if acceptance poured the offset into older invoices
first, an explicit all-debt choice would silently stop relieving the invoice it names. Own-first
also keeps the printed header of the invoice the goods came from carrying the credit first. The
party's tab is reduced by the same total either way; only the per-invoice attribution differs.

## 10. Tests added (red-first)

- `return-calculations.test.ts`: the new decision table (split numbers, tab-covers-return,
  unresolved), `derivedRefundSplit`, `explicitRefundSplit` (#162 cap), the comparator's ordering
  and its numeric invoice-number tie-break, and that it does not mutate its input.
- `router.test.ts`: the split default end to end (create → accept → header reconciles); the
  oldest-first allocation across a party's open invoices (per-invoice credit asserted); an
  explicit all-debt choice that does **not** spill onto the older invoice.
- `drizzle-store.test.ts`: per-invoice attribution (including that the origin invoice does not
  double-count a return whose rows point elsewhere); the backfill's equivalence with the legacy
  read on a database whose table the row predates, plus marker and `NOT EXISTS` idempotency.
- `invoice-returns.test.tsx`: the derived split pre-selection and its note, the cross-invoice
  default with the party tab row, the explicit cap warning, and returning to the derived default.
- `tests/e2e/returns.spec.ts`: the cap test now proves the derived split (no cap note) and the
  explicit re-pick (cap note), and a new cross-invoice spec asserts 900 relieved as 600 + 300 on
  the two older invoices, with both headers reconciling.

## 11. Risks

- The default now moves money onto invoices the owner did not open. The panel shows the tab, the
  note says oldest-first, and the pending state (#68) keeps everything reversible until accept.
- A promised offset can exceed what the tab still owes at acceptance (a payment landed between
  create and accept): the acceptance applies what is left and records the truth in
  `debt_applied`; the cash side is not topped up, exactly as round 1 behaved.
- `return_debt_applications` is a new table and a version bump: an older build must refuse the
  database (ADR-0008 §4.5), and the backfill is marker-gated with a `NOT EXISTS` second guard.
