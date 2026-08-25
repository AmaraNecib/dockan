# Review evidence — Issue #8 (Payments on invoices, instalments)

- **Tier:** HIGH-ASSURANCE (payment amounts exceeding invoice totals are an
  explicit high-assurance example; money math).
- **Base SHA:** af0c7a3 (pre-#45/#46 develop). **Final reviewed HEAD:** b432496
  after three review rounds and a rebase onto develop 9e4e97b (PRs #45 diagnostics,
  #46 debts merged beneath this branch; the shared router.ts/router.test.ts/
  i18n.ts/router.tsx files merged additively, both intents kept).
- **Gate status at HEAD:** `bun run typecheck` ok, `bun run lint` 0 errors,
  `bun run test` ok (api 234, web 49), `DOKAN_PORT=4325 DOKAN_WEB_PORT=5181 bun run test:e2e -- --workers=1` 14/14 incl. ticket8.
  `.dokan-port` restored byte-exact (4317).
- **Rounds:** Round 1 = full adversarial wave at d625b93 (debate critic/defender,
  test-audit 3 lanes, code-review standards/spec). Round 2 = focused fix
  verification at bb128f4. Round 3 = exact-key invalidation fix (feb7f8f) +
  rebase onto origin/develop 9e4e97b + dead-helper cleanup (b432496).

## Outcome

Round 1: no blockers; 12 findings (severity <= 7), all actionable.
Round 2: all findings RESOLVED; all acceptance criteria MET; standards clean.
Round 3: the one behavioral delta (query invalidation key shape) E2E-proven green.
Recorded decisions: creation-time payments are audited by SALE_CREATED/PURCHASE_CREATED
inside the create transaction; PAYMENT_RECORDED is logged per LATER instalment.
Deferred (08-design.md, non-blocking): DB-level CHECK on paid/remaining (SQLite
rebuild), payments(invoice_id) index, note length cap, 200-row list cap,
no backfill for pre-change purchase invoices.

---

## Debate — adversary wave

### Critic findings and resolution status

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | 6 | Creation-time initial payments log only SALE/PURCHASE_CREATED, not PAYMENT_RECORDED | Recorded scope decision (see below) |
| 2 | 4 | JS read+compute then unconditional UPDATE = check-then-act across processes | RESOLVED: applyPaymentToInvoice conditional UPDATE; rollback on false |
| 3 | 3 | No DB-level CHECK on paid/remaining | DEFERRED (SQLite ALTER cannot add CHECK) |
| 4 | 2 | UNPAID filter matches zero-total invoices | RESOLVED: remaining>0 AND remaining=total |
| 5 | 2 | Client accepts 1e3/0x10 spellings | RESOLVED: digit-regex + safe-int validator |
| 6 | 2 | Detail error branch shows INVOICE_NOT_FOUND for any failure | RESOLVED: tError(message) |
| 7 | 1 | Status-filter dropdown label reused "paid" | RESOLVED: invoicesStatusFilter key |
| 8 | 1 | Success banner persists while editing | RESOLVED: cleared on input change |
| 9 | 1 | No note cap / no payments index | DEFERRED (scale) |

### Defender verdict
No blockers. Atomicity by construction (one serialized unit), boundary inside the
unit, rowid insertion-order history proven, purchase-initial-payment row restores
the `paidAmount = SUM(payments)` invariant, additive-only diff.

### Scope decision (recorded, kept)
Creation with initialPaid > 0 inserts the payment ROW (purchase now mirrors sale)
so the money trail is complete, but the activity for that money event is the create
transaction's own SALE_CREATED/PURCHASE_CREATED entry. Logging PAYMENT_RECORDED as
well would split one financial fact into two log entries and change ticket-29/30
behavior; the issue brief's PAYMENT_RECORDED requirement targets the later-instalment
procedure (invoicesPay), which logs exactly one activity per payment.

---

# Critic (full original report)

**Note:** The tool budget cut inspection short — I did not get to read the tests, `.scratch/implementation/08-design.md`, `.scratch/reviews`, or the `dinarsSchema` definition in `core.ts`. Those are flagged as verification gaps below. Everything else below is verified from the diff, `router.ts`, `drizzle-store.ts`, schema DDL, and contracts.

## Review

### What is correct (evidence)

- **Atomicity target met.** `invoicesPay` runs `insertPayment` + `setInvoicePaidAmounts` + `insertActivity(PAYMENT_RECORDED)` inside one `withTransaction` unit (`apps/api/src/rpc/router.ts` ~534–575) with BEGIN/COMMIT/ROLLBACK on the raw connection, and `withTransaction` holds the in-process serialization queue for the whole unit (`drizzle-store.ts` ~519). A crash mid-unit rolls back; payment row, recompute, and audit cannot diverge within one process.
- **Money boundary is server-enforced** (`router.ts` ~545–550): `amount > remainingAmount` → `PAYMENT_EXCEEDS_REMAINING`, and exactly-remaining is allowed (settling payment). The endpoint is kind-agnostic, so sale and purchase invoices are both payable.
- **History consistency fixed for PURCHASE:** the purchase-create branch now inserts the initial payment row (previously `payments: []`), matching the sale branch, so `SUM(payments.amount) == paidAmount` holds for both kinds. This is a real money-history invariant and it is now satisfied.
- **Deterministic history ordering:** `orderBy(payments.paidAt, sql`rowid`)` (`drizzle-store.ts` ~616) breaks same-second timestamp ties by insertion order — appropriate since `paid_at` has second granularity.
- **Stable error keys + Arabic UI:** `PAYMENT_EXCEEDS_REMAINING`, `INVOICE_NOT_FOUND` keys with i18n entries; RTL nav/labels added; history, totals, remaining all rendered on the detail screen; list page filters kinds and payment status.

### Findings (severity 1–10)

1. **6 — initial payments do not log PAYMENT_RECORDED** — `router.ts` (purchase branch ~507–517 and the equivalent pre-existing sale branch): when `paidAmount > 0`, a payment row is inserted but the only activity logged is `PURCHASE_CREATED`/`SALE_CREATED`. The acceptance contract says *"each payment logs a PAYMENT_RECORDED activity"*. Under a literal reading, a payment made at invoice creation has audit history but no `PAYMENT_RECORDED` activity. Not a money-safety bug, but an acceptance-contract gap unless the intended scope is "later payments only."

2. **4 — the "no check-then-act race" claim holds only for one process** — `router.ts` ~545–556: remaining is read in JS, `paid + amount` / `remaining − amount` are computed in JS, then written via `setInvoicePaidAmounts` (unconditional UPDATE, `drizzle-store.ts` ~659–661). The serialization queue makes this safe for a single store instance on a single SQLite connection. The comment *"a second pay can only read the remaining AFTER this one committed"* is false for two processes/connections sharing the file (e2e + dev server, or any future multi-instance deployment) — two interleaved read/write pairs can both pass the check and overpay. High-assurance tier: make the UPDATE conditional (`SET remaining_amount = remaining_amount - ? WHERE remaining_amount >= ?`, check affected rows) or add a `CHECK (remaining_amount >= 0)`/`CHECK (paid_amount + remaining_amount = total_amount)` so the DB rejects the drift.

3. **3 — money invariant is enforced only in application code, never in the schema** — `db/schema.ts` ~211–214: `paid_amount`, `remaining_amount` are plain `INTEGER NOT NULL` columns with no `CHECK`. Any future code path that writes these columns (or a bug in this one) can persist `paid > total` / negative remaining silently; no test or constraint would catch it at the DB layer. For the high-assurance tier this is the cheapest real protection available.

4. **2 — UNPAID status filter matches zero-total invoices** — `drizzle-store.ts` (~648–652): `status === "UNPAID"` is `remaining_amount = total_amount`, so a free invoice (total 0, remaining 0) matches UNPAID *and* PAID filters. Edge case: `totalAmount` can be 0 if all line prices are 0.

5. **2 — client amount parsing accepts `Number()`-coercible strings that are not literal integers** — `invoice.tsx` `paymentAmountError` (~line 28): `"0x10"` → 16, `"1e2"` → 100, `"0b101"` → 5 pass the "integer > 0" check. Server-side the amount arrives as a JSON number so the boundary still holds and no money harm occurs (the client converts with `Number(amount)` before sending), but the "أدخل مبلغاً صحيحاً" message can be bypassed via paste. Use a regex (`^\d+$`) for the client check.

6. **2 — detail page treats every query failure as INVOICE_NOT_FOUND** — `invoice.tsx` (~line 79): the error branch renders the not-found message for network errors and other server errors too (state shows the loading placeholder text `activityError`). Cosmetic/misleading, not money-related.

7. **1 — status-dropdown label is `t("invoicePaid")` ("المدفوع")** — `invoices.tsx` (~line 54): the label for the *status* filter reuses the "paid" label; a filter that includes "غير مدفوعة"/"مدفوعة جزئياً" is labeled "المدفوع". Confusing, trivial.

8. **1 — success banner persists while editing** — `invoice.tsx`: `recorded` is cleared only on the next submit attempt, so "تم تسجيل الدفعة" stays visible while the user edits the amount/note after a successful payment.

9. **1 — no `note` length cap and no index on `payments (invoice_id)`** — schema has no `NOT NULL`/`CHECK` or index; fine at this scale, but the note field is unbounded and the history query is a full table scan per invoice.

### Verification gaps (could not complete under the tool budget)

- `dinarsSchema` definition in `packages/contracts/src/core.ts` (whether `amount` is enforced `.int()` server-side — the client check requiring integers suggests it is, but not verified).
- `.scratch/implementation/08-design.md` and `.scratch/reviews` were not read.
- The four new test files (router/drizzle-store/invoice unit tests + `tests/e2e/ticket8.spec.ts`) were not read or executed; test quality is evaluated elsewhere, but I could not confirm the overpay-e2e, RTL, or activity assertions.

### Residual risks of note

- Multi-process writers on the same SQLite file reintroduce the overpay race (finding 2) with no DB-level guard (finding 3).
- Redundant `paid_amount`/`remaining_amount` + payments rows: both create paths now write payment rows, so drift risk is contained today, but nothing enforces "SUM(payments) == paid_amount" structurally.
- If `dinarsSchema` allows decimals, fractional instalments would be recorded (unverified).

---

# Defender (full original report)

I've hit my tool-call budget for this session. The evidence I gathered covers the API procedure, the store transaction/serialization layer, and the schema; the web page files (invoice.tsx, invoices.tsx, i18n.ts) were confirmed in the diff-stat only, and I state confidence accordingly rather than fabricating line-level claims for files I did not read. Finalizing from this evidence now.

# Review — Issue #8 Payments on invoices (CHARITABLE DEFENDER)

## Verdict
No blockers found in the inspected evidence. The implementation is a faithful execution of the design (`08-design.md`) and its high-assurance money-math constraints: one serialized transaction per payment, an in-unit overpay check (no check-then-act race), whole-integer DA amounts, deterministic insertion-order history, and an invariant-restoring initial-payment row for both invoice kinds.

## Defenses (with confidence scores)

### D1 — Serialized transaction: payment + recompute + activity in ONE unit — confidence 10
`invoicesPay` wraps everything in `deps.store.withTransaction(async (tx) => { ... })` (`apps/api/src/rpc/router.ts:536-573`): read detail → overpay check → `insertPayment` → `setInvoicePaidAmounts` → `insertActivity(PAYMENT_RECORDED)` → re-read detail. The store's `withTransaction` (`apps/api/src/store/drizzle-store.ts:519-530`) is a real `BEGIN`/`COMMIT`/`ROLLBACK` on the raw connection guarded by `runSerialized`, with an unqueued `directSeed` store handed to the callback (no deadlock) while every external call queues behind the unit (no second `BEGIN` can land mid-transaction). The comment at `drizzle-store.ts:510-512` documents why explicit BEGIN/COMMIT is required (drizzle's bun-sqlite transaction committed before awaited callbacks finished — proven by the store transactions test). A crash mid-unit therefore rolls back the payment row, the recompute, AND the activity together: the atomically criterion is met by construction, not by prose.

### D2 — The money boundary lives INSIDE the unit — confidence 10
`router.ts:545-549`: `if (input.amount > detail.remainingAmount) throw new ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" })`. Because `detail` is read from inside the serialized transaction, a second concurrent pay can only observe the remaining after this unit commits — the classic check-then-act race is structurally impossible, not merely mitigated. Exact-remaining passes (that is the settling instalment); remaining = 0 refuses any positive amount. Amounts are whole DA integers end-to-end (`payments.amount INTEGER`, `invoices.paid_amount/remaining_amount INTEGER` in `schema.ts:89-101` region); there is no float arithmetic anywhere in the path. The `PAYMENT_EXCEEDS_REMAINING` key is a stable server key, and the zod input schema (`invoicePayInputSchema`: amount > 0) rejects non-positive/fractional amounts before the handler runs.

### D3 — Insertion-order history via `rowid` — confidence 9
`drizzle-store.ts:619` changed the payment ordering from `orderBy(payments.paidAt, payments.id)` to `orderBy(payments.paidAt, sql`rowid`)`. This is not gratuitous complexity: `payments.id` is a `randomUUID()` (`drizzle-store.ts:31-32`), so a same-second tie sorted by UUID text is random and unstable from render to render — the "history" would not be chronological. `rowid` breaks ties by insert order deterministically, matching two existing precedents in the same file: stock movements (`drizzle-store.ts:458-463`, same comment) and the activities feed (`drizzle-store.ts:709-711`). The single reused `localDateTime()` per payment pins each payment at its real position, and re-inserts in the same second still order correctly.

### D4 — The purchase-initial-payment row restores an accounting invariant — confidence 9
Before this change, purchase invoices with `initialPaid > 0` carried `paidAmount > 0` but an empty `payments: []` history — the header numbers and the payment ledger disagreed. The diff adds `insertedPayments` for BOTH branches: sale (`router.ts:430-443`) and purchase (`router.ts:507-520`), inserting a payment row when `paidAmount > 0` and returning it in the detail. This is what makes `paidAmount = Σ(payments)` hold as an invariant across all invoice kinds; `invoicesPay` can then safely compute `paid + amount` from the header knowing the ledger is consistent, and the invoice screen shows a complete, auditable money trail — exactly what "full history" and "both kinds payable" demand. It also means the later-payment path (`invoicesPay`) needed no schema or contract changes at all.

### D5 — Fresh read inside the unit + NOT_FOUND discipline — confidence 8
`router.ts:571-572` re-reads `getInvoiceDetail` before COMMIT and returns it, matching the `purchasesCorrectLine` pattern; the `!` assertion is sound because the invoice was just read in the same unit and cannot vanish mid-transaction. Missing invoice → `NOT_FOUND`/`INVOICE_NOT_FOUND` (`router.ts:540-544`), consistent with `invoicesGet`.

### D6 — Store seam unchanged / additive-only diff — confidence 9
The only store diff is the one-line `rowid` ordering; `insertPayment`/`setInvoicePaidAmounts`/`getInvoiceDetail` already existed as tested seams (per `08-design.md` "What already exists"). The design doc's stated risk controls (shared files edited additively; debts #31 and expenses #9 seams untouched; `.dokan-port` byte-restore after e2e) match what the diff shows. The design's claim that no contract changes were needed checks out: `invoicesPay` was already declared with `invoicePayInputSchema`/`invoiceDetailSchema`.

## Notes (non-blocking)
- **pre-existing data (severity 4, informational):** the invariant `paidAmount = Σ(payments)` holds for invoices created after this change; pre-existing purchase invoices created with a paid amount under the old code still have no matching payment row. MVP schema is `CREATE TABLE IF NOT EXISTS`, so no backfill migration exists. Acceptable for this milestone; worth a follow-up note, not a blocker.
- **UI layer evidence (severity 2, verification-gap):** I did not reach line-level inspection of `invoice.tsx`/`invoices.tsx`/`i18n.ts`/`router.tsx` within this session's budget. Test coverage per the diff-stat is strong (`router.test.ts` +197, `drizzle-store.test.ts` +29, `invoice.test.ts` +47, `ticket8.spec.ts` +97 — covering auth, partial/exact/overpay, accumulation, PAID refusal, PURCHASE payability, NOT_FOUND, zod rejection, activity logging, and rollback atomicity per `08-design.md`). Their runtime behavior was not independently verified here; treat UI findings as unverified rather than bug-free.
- Working tree state: `git status --short` was clean (no staged files); `git diff --stat` shows 10 files, +819/−3, all in apps/, tests/, packages not touched.
