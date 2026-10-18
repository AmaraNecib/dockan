# Issue #68 — PENDING return shows debtOffset but debts page shows no debt

Branch: `fix/68-return-debt` (base `f4d4674`)

## 1. What the user saw

- Returns page: RTN-0002 `PENDING_REVIEW` shows `cashPaidOut=5000`, `debtOffset=5000`,
  `refundAmount=10000` for INV-0003 (customer "test").
- Debts page: customer "test" → «لا توجد ديون حالياً».

Interpreted as a contradiction: a PENDING (not yet accepted) return appears to promise a
5000 deduction while the debts page claims nothing is owed.

## 2. Investigation

### 2.1 Database inspection

No `apps/api/data/dokan.db` exists in this checkout. The desktop app stores data under the OS
app-data dir (`DOKAN_DATA_DIR` set by the Tauri shell): `%APPDATA%/dz.dokan.app/dokan.db`
(verified via `desktop.rs` `runtime_data_dir` + the `.dokan-port` record in
`dz.dokan.app/run/`).

Queried every candidate DB on this machine (desktop, backups, E2E temp dirs) — none contains
INV-0003 / RTN-0002 / customer "test". The screenshots came from data that is not present here
(dev vs desktop data dirs, branch 3 of the issue checklist). The behavior was therefore
reproduced through the real code path instead (see 2.2), which is deterministic and definitive
for deciding the fix.

### 2.2 Reproduction through the actual code path

Wrote a wire-seam reproduction (router + sqlite in-memory, exactly like
`apps/api/src/rpc/router.test.ts`): customer "test", INV SALE total 10000 paid 5000
(remaining 5000); return of both lines (value 10000) with `cashPaidOut=5000`.

Observed, current code:

```
INV created: INV-0001 total 10000 paid 5000 remaining 5000
RTN: RTN-0001 status PENDING_REVIEW value 10000 cash 5000 debtOffset 5000
invoice after return: remaining 0 paid 5000
debts page owedToUs: []                     ← «لا توجد ديون حالياً»
after REJECT: status REJECTED_DAMAGED invoice remaining 0
```

This exactly matches the user's screenshot, including the surprise that REJECTing the return
does not restore the debt.

### 2.3 Root cause

`returnsCreate` (`apps/api/src/rpc/router.ts`) computes the split and then calls
`applyDebtOffsetToInvoice` **in the same transaction as the insert** — while the return is
still `PENDING_REVIEW`:

```ts
if (debtOffset > 0 && !(await tx.applyDebtOffsetToInvoice(invoice.id, debtOffset))) { ... }
```

So a provisional, reviewable return settles the debt immediately and irrevocably:

1. The debts page reads `SUM(remaining_amount)` from `invoices` (`debtSummaries`) — after the
   offset the invoice is at 0, so the customer disappears from the debts screen even though the
   return has not been accepted.
2. Rejecting the return never restores the offset (`returnsReject` only scraps stock). The
   owner promised 5000 debt relief; it stays applied even when the goods are rejected as
   damaged.

`#59` documented the same-unit application, but the app's own profit report already treats
PENDING returns as provisional (while pending, the sale line is un-booked — see router test
"reject after a resale books the original line only for the scrapped-now portion": pending →
revenue delta 0). The debt ledger was the inconsistent exception.

### 2.4 Decision

**Defer the debt offset application from return creation to return acceptance.**

- `returnsCreate`: keep the voucher split math untouched (the owner's chosen split at the
  counter, capped at the debt as of recording) but **do not** touch
  `invoices.remaining_amount`. While a return is PENDING, the invoice keeps its full debt, so
  the debts page truthfully shows the customer's debt.
- `returnsAccept`: inside the same BEGIN IMMEDIATE unit that consumes the stock mark, apply
  `min(debtOffset, remaining-at-accept)` to the invoice. A cap (not a hard refusal) is used
  because two pending returns may each have been capped at the same creation-time debt; the
  first accept shrinks it, so the second can only relieve what is still owed. The existing
  guarded UPDATE stays as a fail-loud guard against corruption.
- `returnsReject`: never applies the offset (rejected goods mean the promised deduction is
  cancelled; the customer still owes the original debt). This also closes the reject hole found
  during investigation.

Cash (`cashPaidOut`) is unchanged: it is a physical handover at the counter and stays immediate
as designed in #59.

### 2.5 Effects on the user's scenario (after fix)

- PENDING return: invoice remaining stays 5000 → debts page shows "test" 5000 → «لا توجد ديون»
  no longer appears.
- ACCEPT: offset applied → remaining 0 → debts page empty, consistent.
- REJECT: offset never applied → remaining stays 5000 → customer still owes; goods scrapped.
- Returns card copy becomes status-aware so the pending state reads honestly.

## 3. UI copy changes (make the state legible)

- Returns review card: status-aware debt label —
  `PENDING_REVIEW` → «خصم من الدين (عند القبول)», `ACCEPTED` → «خصم من الدين (مطبّق)»
  showing the amount really applied (`debtApplied`, possibly less than the recorded
  promise after the accept-time cap), `REJECTED_DAMAGED` → «خصم من الدين (لم يُطبّق)»
  with one exception: a LEGACY rejected row whose offset the migration backfilled as
  applied reads as «مطبّق» (that debt relief happened pre-#68 and stays).
- Invoice return panel: when a debt portion is projected, add a one-line note
  «خصم الدين يُطبّق عند قبول المرجوع» so the counter owner is not surprised that the invoice
  keeps its debt while pending.
- Return voucher print: debt line label status-aware (same keys) so a print taken after a
  rejection does not claim an applied deduction.

## 4. Tests

API (TDD, `apps/api/src/rpc/router.test.ts`):
- Update the #59 "parent scenario" test: after creation remaining stays 1000; after ACCEPT
  remaining 700.
- Update "never lets the debt go negative": creation leaves remaining 300; accept applies the
  capped 300 → 0.
- Update "caps each return against the remaining debt AFTER previous offsets": successive
  pending all-debt returns leave the debt untouched until accept; accepts apply sequentially.
- New: the #68 user scenario — sale 10000/paid 5000/remaining 5000, return 10000 split
  cash 5000/debt 5000 → while PENDING remaining stays 5000 and `reportsDebts` still lists
  "test" 5000; after ACCEPT remaining 0 and `reportsDebts` is empty.
- New: REJECT never applies the offset (remaining stays 5000).
- New: over-promise clamp — two pending all-debt returns vs one debt; accepting the second
  applies only what remains.

Store: no change (`applyDebtOffsetToInvoice` semantics unchanged).

Web: label string swap is covered by existing unit tests (they assert amounts, not the old
label); i18n keys added.

## 5. Risks / notes

- Behavior change is the fix: the debt now survives until the return is accepted. If an owner
  previously relied on the immediate deduction, they now see it land on acceptance.
- The voucher/document still records the owner's chosen split (a promise); only the ledger
  application timing changed.
- No returns E2E spec exists; API + web unit coverage carries the change. `returnsAccept`'s
  transaction already serializes (BEGIN IMMEDIATE), so the accept-time apply cannot race.