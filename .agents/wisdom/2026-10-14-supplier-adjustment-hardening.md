# Supplier-adjustment hardening: a server-stamped retry key guards nothing

**Date:** 2026-10-14 · **Tickets:** 177, 180 · **Area:** apps/api/src/store/drizzle-store.ts, apps/api/src/rpc/router.ts, apps/web/src/lib/amount-parse.ts

Follow-ups from #176. The lessons the debate/test-audit/code-review caught:

0. **An idempotency key that includes a server-minted id is defeated by the very
   retry it targets.** The opening-balance signature was keyed on `supplierId`,
   but a lost-response resend of a `newSupplierName` batch ran `createParty`
   again, minting a fresh id — so the dedup never saw the first entry and the
   balance doubled. Resolve a typed name to the existing supplier (same
   `normalizeTextKey` fold the picker uses) BEFORE creating one. When duplicate
   names already exist, prefer the entry-carrying row deterministically. Test the
   retry with the response thrown away, not just the happy path.

1. **A retry guard keyed on a server-stamped timestamp does not guard retries.**
   `occurredAt ?? localDateTime()` gives each request a fresh second, so an
   omitted-date retry never matches. When the signature must include the
   timestamp, also pass a `serverStamped` flag and drop the timestamp from the
   duplicate key in that case (match any time). The UI always sends its form
   date, so this closes the script/import hole; a caller that sends a *changing*
   timestamp still needs an explicit client idempotency key (deferred).

2. **Re-validate money at the store seam, not only at the transport contract.**
   A negative `amount` makes the conditional clamp
   `remaining_amount >= amount` true and `remaining_amount - amount` *increases*
   the debt. Guard "non-contract caller" methods with
   `Number.isSafeInteger(amount) && amount > 0`.

3. **A guarded write that assumes a caller-opened unit must assert it.**
   `insertSupplierAdjustment` refuses to run unless `conn.inTransaction` (the
   `withTransactionImmediate` flag). Outside the unit the duplicate check races
   and the entry can commit without its reduction. Alternatively have the method
   own the unit — never document the requirement and hope.

4. **A "store backstop" that skips ownership is not a backstop.**
   Re-check the linked invoice's `kind` and `counterpartyId` inside the store,
   or a non-UI caller can credit supplier A while reducing supplier B's invoice.

5. **Extract the conditional debt-offset SQL once.** Two copies of the
   `remaining_amount >= ?` clamp can drift; one `applyDebtOffset` helper backs
   both the adjustment and the return path.

6. **Do not change production ordering to satisfy a flaky test.** A pre-existing
   invoice-status test inspected a global paginated list and broke on
   same-second `createdAt` ties once more invoices existed. The tempting fix was
   a `rowid DESC` tie-break in `listInvoices` — out of scope for the ticket.
   Fix the test instead (`limit: MAX_PAGE_SIZE`), and note the ordering fragility
   as a follow-up. If the tie-break is genuinely wanted, land it as its own
   ticket with its own design.

7. **Every new refusal code needs an i18n entry.** `tError` renders unmapped
   codes raw; the UI showed `DUPLICATE_ADJUSTMENT` until the Arabic strings were
   added. Removing a code's last throw means removing its key too.

8. **"One parser everywhere" includes the submit-side readers.** Making the
   `AmountPercentageInput` field accept `1 000` while `paymentAmountError` /
   `saleDebt` / `settleAmountError` still parse digits-only re-creates the exact
   "same string, two numbers" bug. Move the field reader and every validator that
   reads the same draft, and keep quantities on the strict reader.

9. **A confirmation gate derived from a stale client list must MOVE the draft, not
   just re-send it.** The bulk opening-balance dialog confirmed rows by existing id;
   when the typed supplier raced into existence the new-name row could not be
   confirmed and the save silently dropped it. Resolve the typed name to the
   existing supplier with the same `normalizeTextKey` fold the server uses and move
   the amount+direction onto that row. Do the move BEFORE the confirmation (an
   effect) and keep a synchronous fallback in the save, or a same-tick save can still
   drop the row. Gate the effect on the name field being unfocused, or an owner
   typing a new name that starts like an existing one loses the amount mid-word.
   Removing the now-dead duplicate-name error also orphans its i18n key and testid;
   delete them.
