# #256 round 2 — test audit (run by the lane, not an independent auditor)

Reviewed code: **7020666**. Gate disclosed: **not** an independent `test-audit` sub-agent run —
the lane wrote this list. Round 1 disclosed that the review-gate launches failed; the parent
runs the independent gates against this SHA.

## Edge cases that ARE tested (and where the assertion that would fail lives)

| case | test | assertion that must fail if broken |
| --- | --- | --- |
| no debt anywhere → cash | `return-calculations.test.ts` "defaults to cash…" | `toEqual({ method: "CASH" })` |
| tab = return value (equality) → debt, not split | "defaults to debt when the party's tab covers a return this invoice cannot" | `toEqual({ method: "DEBT" })`; ablated boundary (`<=` → `<`) fails exactly here |
| return > tab → split numbers | "splits when the return exceeds the whole tab" | `{ debtOffset: 4_000, cashPaidOut: 1_000 }` |
| party read unresolved | "stays unresolved…" | `UNRESOLVED`; plus the own-debt-answers-alone case |
| zero-value return | "never blocks a free (zero-value) return" | `DEBT` for both `partyDebt` 0 and 400 |
| explicit #162 cap | "caps an explicit all-debt request…" | 500/0 against 300 debt → `{300, 200}` |
| ordering: equal date/second, numeric number tie-break | `sortInvoicesOldestFirst` "orders by date, then creation…" | `INV-0009` before `INV-0010` (a lexical compare fails) |
| ordering: input array not mutated | "does not mutate the array it was handed" | both the returned id order and the input's |
| split default end to end | `router.test.ts` "splits the default…" | `debtOffset 300 / cashPaidOut 200`, pending untouched, header `900−200−700=0` |
| cross-invoice allocation, oldest first | "allocates the default across the party's open invoices, OLDEST first" | per-invoice credit `200` / `100` + both headers reconcile; the ablation (no sort) fails |
| explicit choice does not spill | "keeps an EXPLICIT all-debt choice on its own invoice" | older invoice keeps 200, credit 0; the own-first ablation fails here |
| acceptance caps at the debt still owed (#68) | pre-existing "applies accepted offsets sequentially…" | 2000 → 1500 → 1000 → 500 |
| per-invoice attribution + no double count | `drizzle-store.test.ts` "attributes one accepted offset to each invoice…" | origin invoice credit `0` while its return has `debt_applied 300` elsewhere |
| backfill equivalence + idempotency | "backfills attribution for an already-applied return…" | credit equal before/after; 1 row; still 1 with the marker lost |
| legacy fallback read | pre-existing "sums the debt the invoice's returns actually relieved" | 500 with no attribution rows; removing the fallback fails it |
| web: derived split pre-selection + note | `invoice-returns.test.tsx` "pre-selects the SPLIT…" | 300/200, note present, no cap note, payload ABSENT |
| web: cross-invoice default + tab row | "pre-selects all-debt and points at the party's tab…" | debt 900 / cash 0, `returns-party-debt` 900, note mentions الأقدم |
| web: explicit cap still warns | "keeps the explicit all-debt cap on THIS invoice…" | 700/200 + `returns-debt-cap-note`, payload `cashPaidOut: 0` |
| web: back to the derived default | "goes back to the derived default…" | `returns-debt-confirm` resets to 300/200 and the payload to ABSENT |
| e2e: the user flow | `returns.spec.ts` (3 specs) | derived default visible, voucher, accept, reconciled headers, 600+300 cross-invoice relief |

## Edge cases NOT covered (missing, or only argued)

1. **Acceptance after the tab shrank** (a payment or another acceptance took the debt between
   create and accept). The code applies `min(stillPromised, remaining)` and records the truth;
   no test drives that path with the new multi-invoice loop. Round 1 tested the same shape
   single-invoice only.
2. **A party whose debt is on an invoice of the OTHER kind** — a SALE return only ever walks
   `kind: "SALE"`; a purchase invoice for the same counterparty must never be touched. Not
   tested (the kind filter is in `listUnpaidInvoicesByParty`, exercised indirectly).
3. **A walk-in return (no `counterpartyId`, no `counterpartyName`)** — `partyOutstandingDebt`
   returns the own invoice's remaining, and step 2's party read cannot match; no test asserts
   that a walk-in rejection/accept does not reach other invoices.
4. **A typed-name party vs an id-backed party** (the #120 identity split): the cross-invoice
   e2e seeds a typed name; an id-backed `counterpartyId` party is covered only by the router
   test's `customersCreate` shape, not both at once with a cross-invoice offset.
5. **Two PENDING returns whose promises together exceed the tab**, accepted in sequence: the
   second one now reaches the older invoices instead of applying nothing. The pre-existing
   sequential test uses one invoice with enough debt, so the new spill path is untested.
6. **More than two invoices** in the allocation loop (the loop's ordering and its `left <= 0`
   break are only exercised with two).
7. **`return_debt_applications.amount` never zero/negative** — no CHECK constraint; the router
   only ever pushes `take > 0`, but a future caller could write 0. Not asserted.
8. **The rejected-return path** (`returnsReject`) against a cross-invoice promise: rejection
   never applies debt (#68), and no test asserts that a cross-invoice promise is fully dropped
   on rejection.
9. **Backup/restore round-trip** with the new table: the whole-DB image covers it, but no test
   asserts a restored image keeps attribution rows (the encrypted-store tests do not seed them).
10. **Voucher copy for a cross-invoice offset**: the voucher shows `debtOffset`, not which
    invoices were relieved; nothing asserts the printed voucher is honest about the split.

## Shallow-assertion check on the new tests

Every new test asserts money values or a reconciled invariant (`total − paid − returnCredit =
remaining`) rather than "renders". The two idempotency assertions (row count stays 1) would pass
vacuously if the backfill never inserted — which is why the same test also asserts the row
exists and the credit is unchanged; both fail under the ablation where the fallback is removed.
