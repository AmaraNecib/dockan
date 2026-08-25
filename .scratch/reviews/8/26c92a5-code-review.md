# Round-4 addendum — PR #48 fresh finding: stale-snapshot busy error (fixed at 26c92a5)

**Finding (validated real):** with a deferred BEGIN, two app processes paying the
same invoice each take a WAL read snapshot in their (read) transaction; the loser
upgrades to a write, hits SQLITE_BUSY_SNAPSHOT, and the RPC returns an internal
error instead of PAYMENT_EXCEEDS_REMAINING (busy_timeout does NOT apply to the
snapshot error; it only covers the plain BUSY retry loop).

**Validation (differential, two real processes):** a synchronized two-worker
probe against one file showed — `BEGIN` (pre-fix shape): [APPLIED, ERROR
"database is locked"]; `BEGIN IMMEDIATE` (fix): [APPLIED, REFUSED]. Final state
identical (600/200) in both, only the loser's RESPONSE differs.

**Fix:** `StorePort.withTransactionImmediate(fn)` — the write lock is acquired
BEFORE the first read (BEGIN IMMEDIATE on the raw connection), so a concurrent
process waits in its own thread via busy_timeout, then reads the post-commit
state and the conditional UPDATE refuses with the boundary error. Wiring:
- drizzle-store.ts: shared `runTransaction(immediate, fn)` body; both
  `withTransaction` and `withTransactionImmediate` are exempt from the
  per-instance queue wrapper (otherwise the inner queue would deadlock).
- router.ts `invoicesPay` runs in the write-first unit; the audit-boom
  atomicity harness now wraps the immediate variant as well.
- This pre-empts the BEGIN IMMEDIATE hardening previously deferred in issue #43
  for the payments path — #43 can drop that item.

**Regression:** store test spawns two REAL processes (Bun.spawn workers on a
go-flag) paying concurrently: exactly one APPLIED + one REFUSED, exit codes 0,
never a raw SQLite error. Subprocesses are required because bun is
single-threaded: an in-process second connection's synchronous busy-wait would
starve the winner's async continuation, an environment artifact that does not
exist across processes.

**Gates at 26c92a5:** typecheck ok, lint 0 errors, test ok (api 235, web 49),
e2e 14/14 (one run of the suite's known timing-sensitive ticket-28 scan spec
flaked under load, retries: 0; two subsequent full runs green) — `.dokan-port`
restored byte-exact. Evidence re-keyed to the code head de06d11; the commits
after it are .scratch/.agents docs only.

---

---

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

## Code review — Standards + Spec axes

### Standards (round 1 + re-check)
Whole-DA integer money everywhere incl. new SQL arithmetic; SAFETY comments on
every new type assertion (anti-slop clean); store-seam discipline (raw SQL only
inside the drizzle-store adapter); additive edits to shared files; debts/expenses
seams untouched; RTL/Arabic conventions. Round-1 notes fixed: role="status" live
region; validator spelling gap; e2e SAFETY comments; EOF newlines; plan deviation
(rowid ordering) justified and tested. Rebasing merged PRs #45/#46 cleanly.

### Spec (round 1 + re-check at final HEAD) — all criteria MET
Each mapped to a passing test (see coverage table); the bb128f4 re-check confirmed
all eight criteria MET with reviewer-executed suites; final HEAD re-verified after
rebase.

---

# Standards (full)

## Review — Issue #8 (payments on invoices), diff `af0c7a3...HEAD` (d625b93)

Read-only review performed: full diff of all 11 changed files, `git show HEAD` for `router.ts`, `drizzle-store.ts`, new `invoice.tsx`/`invoices.tsx`, `08-design.md`. Working tree clean (nothing staged). Tests were **not executed** in this session (read-only review; see residual risks).

### Correct (with evidence)
- **Money is whole-DA integer throughout** — router: `input.amount > detail.remainingAmount`, `detail.paidAmount + input.amount`, `remainingAmount - input.amount` (router.ts ~537–577) are pure integer math; client `paymentAmountError` uses `Number.isInteger(value) && value <= 0` rejection (invoice.tsx:24–30); schema zod rejects `0, -5, 12.5, NaN` (router.test.ts coverage); no float anywhere in the money path.
- **Atomicity: one serialized unit** — `invoicesPay` runs entirely inside one `withTransaction` (router.ts:536–573): read → boundary check → insertPayment → setInvoicePaidAmounts → insertActivity → re-read. The check is inside the unit, which per drizzle-store.ts:519–535 holds the single-connection queue exclusively, so no check-then-act race survives. Rollback proven by the `audit-boom` test (router.test.ts) that asserts payment row absent + paid/remaining unchanged + no phantom activity row.
- **SAFETY comments (oxlint anti-slop) present on every new cast** — `as PaymentMethod` (invoice.tsx:150), `as KindFilter`/`as StatusFilter` (invoices.tsx:46, 66), the `!` non-null re-read (router.ts:574), `(err as Error)` ×2 (router.test.ts). Consistent with the store's existing SAFETY discipline (drizzle-store.ts:196–223).
- **Store-seam discipline** — all SQL (the `sql`rowid`` tiebreak) is inside drizzle-store.ts; router speaks only `StorePort`. The design doc's own rule "no SQL outside drizzle-store.ts" holds.
- **Additive edits to shared files** — router.ts replaces the dedicated `notImplemented("invoicesPay")` stub owned by this ticket (the intended seam) plus a 6-line `insertedPayments` block in purchase creation; router.test.ts, i18n.ts, router.tsx are purely appended. Debts (#31) and expenses (#9) seams untouched (diff touches only the 11 listed files; `debtSummaries` not in diff).
- **History ordering fixed correctly** — `orderBy(paidAt, rowid)` (drizzle-store.ts:619) replaces random-UUID id tiebreak for same-second instalments; covered by a deliberate same-stamp store test (drizzle-store.test.ts) and e2e history-in-order assertions.
- **RTL/Arabic conventions** — all strings Arabic via i18n; `dir="ltr"` on dates/amounts; `text-right` tables; `role="alert"` on errors; exact Arabic overpay message `المبلغ يتجاوز المتبقي` verified in e2e.
- **Acceptance bullets verified in tests/screen**: partial reduces remaining (test), overpay +1 refused with exact `PAYMENT_EXCEEDS_REMAINING` + nothing written (test + e2e), accumulation (test), full history on invoice screen (table + testids), `PAYMENT_RECORDED` per payment with ref+number (test + e2e audit filter), PURCHASE invoices payable (test), disabled form at remaining=0 (UI + e2e).

### Findings (severity 1–10)

| Sev | File:line | Finding |
|---|---|---|
| 3 | apps/web/src/pages/invoice.tsx:213 (`pmt-done`) | Success announcement is a plain `<p>` with no `role="status"`/live region — inconsistent with the repo's t10 convention (settings save added a `role=status` live region for exactly this). Screen-reader users get no announcement of a recorded payment; error path does use `role="alert"`. Recommend matching the t10 pattern. |
| 2 | apps/web/src/pages/invoice.tsx:25–27 | `paymentAmountError` accepts numeric-string forms like `"1e3"` (→1000) and `"0x10"` (→16) as valid whole instalments. Cosmetic only — the server boundary is authoritative and zod int + remaining check gate the write; still a small client-side validation gap vs. the "exact clear error" contract (these inputs pass silently). |
| 2 | tests/e2e/ticket8.spec.ts:46 | `match(/INV-\d{4}/)![0]!` non-null assertions without SAFETY comments (also `categories.items[0]!` in router.test.ts) — the anti-slop rule is applied to `as` casts in this diff but `!` assertions here lack the comment discipline; low impact (test-only), but inconsistent with the standard this repo otherwise enforces. |
| 1 | apps/web/src/pages/invoice.tsx, invoices.tsx, router.test.ts, invoice.test.ts, ticket8.spec.ts | All new files/hunks end without trailing newline (`\ No newline at end of file`) — cosmetic, easy formatting noise for later diffs. |
| 1 | apps/api/src/store/drizzle-store.ts:619 | Design doc 08 said "no store changes needed," yet the seam changed `orderBy`. Justified and tested (same-second ordering fix), so this is a plan-deviation note, not a defect. |
| 1 | apps/web/src/pages/invoice.tsx:120 + onSuccess | Client boundary uses the query's `remaining`; a stale tab could still submit an overpay. Safe: server returns `PAYMENT_EXCEEDS_REMAINING` which `tError` maps to the exact Arabic message shown inline. Residual, not blocker. |

**Blocker: none.**

---

---

# Spec (full)

# Review — Issue #8 Payments on invoices (branch `feat/8-payments`, HEAD `d625b93`)

## Review

### Correct (verified with passing tests + code reading)

- **Partial payment reduces remainingAmount** — MET. `apps/api/src/rpc/router.ts:560` recomputes both columns inside one unit: `tx.setInvoicePaidAmounts(detail.id, detail.paidAmount + input.amount, detail.remainingAmount - input.amount)`. Router test "records a partial payment: remaining drops, paid rises, history grows" (300 paid → paid 300 / remaining 500, persisted on re-read) — **passed**.
- **Overpay refused with exact, clear error** — MET. Check runs *inside* the transaction: `router.ts:551` `throw new ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" })`. Server key is in the error namespace with Arabic text `المبلغ يتجاوز المتبقي من الفاتورة` (`apps/web/src/lib/i18n.ts`), and `tError` (i18n.ts:261) resolves it with UNEXPECTED fallback. Web side enforces the same boundary before sending: `paymentAmountError` (`apps/web/src/pages/invoice.tsx:28-36`) → `EXCEEDS` → `pmtExceedsRemaining` inline error with the exact remaining. E2E asserts the Arabic message.
- **Multiple payments accumulate** — MET. Test "accumulates multiple instalments…" (200 + 250 → paid 450 / remaining 350, history `[200,250]`, methods CASH then BANK) — **passed**. Accumulation re-derives from the fresh in-transaction read, so it is idempotent under the serialized unit.
- **Full history on the invoice screen** — MET. `apps/web/src/pages/invoice.tsx` renders every `invoice.payments` row (`pmt-history` table, amount/method/note/paidAt, order `paidAt, rowid` in `apps/api/src/store/drizzle-store.ts:619`). `getInvoiceDetail` returns the full payment list; store test pins same-second insertion order via `rowid` tiebreak — **passed**. E2E asserts 2 rows in recording order.
- **PAYMENT_RECORDED activity per later payment** — MET. `router.ts:562` inserts `{ type: "PAYMENT_RECORDED", summary: "تسجيل دفعة … على <invoiceNumber>" }` inside the same unit as the payment. Test asserts 2 records for 2 payments, summary contains the invoice number — **passed**. E2E filters the activity table for `تسجيل دفعة` rows and finds 2.
- **Arabic RTL UI** — MET. Root is `apps/web/index.html:2` `<html lang="ar" dir="rtl">`; all new strings, nav label `navInvoices`, filters, form, testids and error copy are Arabic; dates headed `dir="ltr"` where appropriate.
- **BOTH sale and purchase payable** — MET. The handler is kind-agnostic (any invoice id). Test "accepts later payments on PURCHASE invoices too" (total 600, initialPaid 200 → pay 400 → paid 600 / remaining 0) — **passed**. Web `/invoices` lists both kinds with filters.
- **Atomicity: insert + recompute + activity in ONE transaction** — MET. Everything runs inside `deps.store.withTransaction` (`router.ts:539`), which issues explicit BEGIN/COMMIT/ROLLBACK on the raw connection and serializes against all other store calls (`apps/api/src/store/drizzle-store.ts:519-538`). Test "rolls the payment back when the audit insert fails": `insertActivity` throws → payment row absent, paid/remaining unchanged, no activity row — **passed**. The creation-path initial payment is also inside its existing create transaction (`router.ts:433`, `router.ts:510`).
- **Boundary: exact-remaining accepted, +1 DA refused** — MET on both sides. Exact: router test "accepts an exact-remaining payment (boundary) and marks the invoice PAID" (800 → remaining 0, appears under `invoicesList({status:"PAID"})`) — passed; web `paymentAmountError("1", 1) === null` and `"800", 800` accepted. +1: router test "refuses a +1 DA overpayment with PAYMENT_EXCEEDS_REMAINING and writes nothing" (801 → refused; payment count, paidAmount, remainingAmount, activity count all unchanged) — passed; web `paymentAmountError("801", 800) === "EXCEEDS"`; E2E refuses 601 on remaining 600.
- **Schema hardening** — `invoicePayInputSchema` (`packages/contracts/src/core.ts:412-417`) uses `dinarsSchema` (`z.number().int().min(0)`) + `refine(v => v > 0)`, so 0, negatives, fractional and NaN are rejected before the handler (test passed). Money is whole-DA integers end to end.

### Findings

| Sev | File:line | Finding |
|-----|-----------|---------|
| 2 | `router.ts:433, 510` | Note: an initial payment made *at invoice creation* (`paidAmount > 0`) is inserted and/or committed within the create unit but logs only the `SALE_CREATED`/`PURCHASE_CREATED` activity, not `PAYMENT_RECORDED`. If "each payment logs a PAYMENT_RECORDED activity" is read literally to include creation-time payments this is a gap; ticket scope ("later payments… in instalments") suggests it is out of scope. Residual risk. |
| 1 | `invoice.tsx:55-60` | Note: amount input is `inputMode="numeric"` but not `type="number"`, and `paymentAmountError` uses `Number(amount)`, so strings like `"1e3"` or `"0x10"` coerce to integers client-side. No money-safety impact: the API re-validates (zod int) and re-checks the boundary inside the transaction. |
| 1 | `drizzle-store.ts:681` (listInvoices) | Note: `/invoices` caps at 200 rows without pagination — pre-existing pattern, not ticket scope. |
| 2 | E2E `ticket8.spec.ts` | Note: e2e covers the full acceptance path (instalments, overpay refusal with exact Arabic message, history order, locked form, audit rows) but was not executed here (playwright not run; api/web unit suites all green). |

### Commands run
- `git diff af0c7a3...HEAD --stat` — ok (11 files, +937/−3)
- `bun test apps/api/src/rpc/router.test.ts apps/api/src/store/drizzle-store.test.ts apps/web/src/pages/invoice.test.ts` — **113 pass, 0 fail** (439 expects, 7.24s); all 10 ticket-8 router cases, the store accumulation test, and all 5 `paymentAmountError` cases passed.

No files were modified (read-only review; repo reported a clean working tree).

---

# Round-2 verification (full)

All evidence gathered. Here is my verification review.

## Review — Verification of Round-1 findings at HEAD `bb128f4` (base `af0c7a3`)

**Review scope:** `git diff af0c7a3...HEAD` (13 files, +1299/−5), `.scratch/implementation/08-design.md`, live test runs of the API and web suites.

### Item-by-item verdict

**1. Cross-process overpay race → `applyPaymentToInvoice` conditional UPDATE — RESOLVED** (severity n/a)
- `apps/api/src/store/drizzle-store.ts:615-622`: single `UPDATE invoices SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ?, updated_at = ? WHERE id = ? AND remaining_amount >= ?`, returns `changes > 0`; new seam documented in `apps/api/src/store/port.ts:94-99`.
- Router `invoicesPay` (`apps/api/src/rpc/router.ts:541-548`) calls it inside `withTransaction`, rolls the whole unit back on `false` with `PAYMENT_EXCEEDS_REMAINING`.
- **Cross-connection proof at the store level:** `drizzle-store.test.ts` "a second connection can no longer overpay the invoice" — a separate `openConnection`/`createDrizzleStore` on the same file gets `false` on a stale-remaining apply; **passed in my run**.
- Atomicity proven by the failing-`insertActivity` rollback test (payment row absent, amounts unchanged) — the raw `conn.raw` UPDATE demonstrably shares the unit's rollback.

**2. No concurrency test → router concurrent-instalments test — RESOLVED**
- `apps/api/src/rpc/router.test.ts` "two concurrent payments serialize and never overpay the invoice": `Promise.allSettled` over two simultaneous RPC calls — exactly 1 fulfilled (`paidAmount 600, remaining 200`), 1 rejected with `PAYMENT_EXCEEDS_REMAINING`, 1 payment row persisted. **Passed in my run.**

**3. `dinarsSchema` unbounded → capped — RESOLVED**
- `packages/contracts/src/core.ts:16`: `z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)` with rationale comment.
- Router test "rejects amounts beyond the safe-integer money range at the schema" (`2**53`) → `Input validation failed`. **Passed** (114/114 API tests).

**4. UNPAID matches zero-total → `remaining>0` guard — RESOLVED**
- `apps/api/src/store/drizzle-store.ts`: UNPAID branch now `remaining_amount > 0 AND remaining_amount = total_amount` (comment: excludes free/discounted invoices); PARTIAL branch already had `> 0`.
- Store test "never classifies a zero-total invoice as UNPAID" (PAID instead). **Passed.**

**5. Client accepts `1e3`/`0x10` → digits regex + safe-int — RESOLVED**
- `apps/web/src/pages/invoice.tsx:22-29` `paymentAmountError`: trims, `/^\d+$/u`, `Number.isSafeInteger`, `> 0`, then `> remaining` → `"EXCEEDS"`.
- Web tests cover `1e3`, `0x10`, `12.`, ` 12 ` (trimmed → OK), `9007199254740993` → INVALID. **Passed** (12/12 web tests).

**6. Status-filter label `t(invoicePaid)` → `invoicesStatusFilter` — RESOLVED**
- `apps/web/src/pages/invoices.tsx:45` uses `t("invoicesStatusFilter")`; key exists in `apps/web/src/lib/i18n.ts` ("حالة الدفع"). The `invoicePaid` key is used only for the detail-page "المدفوع" label, which is correct.

**7. Detail page shows INVOICE_NOT_FOUND on any error → `tError` fallback — RESOLVED** (minor note)
- `apps/web/src/pages/invoice.tsx:99-108`: error branch renders `tError(detailError)`; `tError` (`i18n.ts:262-266`) falls back to `UNEXPECTED` for unknown keys. Known key `INVOICE_NOT_FOUND` maps to its Arabic text; any other error no longer masquerades as "invoice not found".
- Note (pre-existing, not introduced by this branch): for truly unknown keys `tError` returns the literal defaultValue string `"UNEXPECTED"` (Latin), not the Arabic `UNEXPECTED` translation. Severity 1, cosmetic.

**8. Success banner persists on edit → cleared in onChange — RESOLVED**
- `invoice.tsx`: all three inputs (`pmt-amount` line 142, method line 156, note line 170) call `setRecorded(false)` on change; `submit` also resets `recorded`/`error` first.

**9. Note `''` vs `null` → trimmed to null — RESOLVED**
- `router.ts:539`: `input.note == null || input.note.trim() === "" ? null : input.note.trim()`; contract note is `z.string().nullable().optional()` (`core.ts:418`).
- Router test "normalizes an empty or whitespace-only note to null" and "defaults method to CASH / note null when omitted". **Passed.** Web sends `undefined` for empty note (`invoice.tsx:132`), consistent.

**10. Web mock missing queryKey / component untested → PaymentPanel + full mock + tests — RESOLVED** (count note)
- `PaymentPanel` extracted router-free in `invoice.tsx` (mirrors `LinkProposalPanel`); `InvoicePage` keeps router-coupled bits.
- `invoice.test.tsx` `mock.module("@/lib/rpc")` now provides the full util surface: `queryOptions`/`queryKey`/`mutationOptions` for `invoicesGet`/`invoicesList`/`activitiesList`/`invoicesPay` (exactly what the component calls), so no runtime `queryKey` gap is possible.
- 12 tests: 6 `paymentAmountError` (boundary, +1 overpay, paid-off, non-numeric, scientific/hex spellings, safe-int) + 6 `PaymentPanel` (empty history, ordered rows incl. `—` null-note, client-side overpay block asserting `lastPayInput === null`, valid submit + `role="status"` success, server-refusal Arabic translation, locked form at remaining 0). **All passed in my run.**
- Note: the round-1 ask literally said "7 component tests"; the file has 6 PaymentPanel tests (+6 validator tests). Coverage is beyond the ask in aggregate; flagging the count only for exactness. Severity 1.

**11. e2e `INV-\d{4}` width + overpay not proven wire-free — RESOLVED** (by inspection; e2e not executed here)
- `tests/e2e/ticket8.spec.ts:51`: `/INV-\d+/` regex. Wire-free proof: `page.on("request")` counter on `/api/rpc/invoicesPay`; after the 601 overpay attempt `expect(payRequests).toBe(payRequestsAfterFirst)` (line 89), and after the settling payment `toBe(payRequestsAfterFirst + 1)` (line 106).

**12. EOF newlines — RESOLVED for all new code files** (1 scratch note)
- Byte-checked every changed file: all new/added code files (`router.test.ts`, `drizzle-store.test.ts`, `invoice.test.tsx`, `invoices.tsx`, `invoice.tsx`, `router.tsx`, `ticket8.spec.ts`) end with `\n` (0x0a).
- The five files still lacking a trailing newline at HEAD (`router.ts`, `drizzle-store.ts`, `port.ts`, `i18n.ts`, `core.ts`) **already lacked it at base `af0c7a3`** — pre-existing, not introduced here.
- Sole exception introduced by this work: `.scratch/implementation/08-design.md` ends with `0x2e` (`.`) with no newline — a scratch design doc. Severity 1.

### Test runs (evidence)
- API: `bun test src/rpc/router.test.ts src/store/drizzle-store.test.ts` → **114 pass / 0 fail**, incl. all ticket-8 payment, concurrency, and cross-connection tests.
- Web: `bun test src/pages/invoice.test.tsx` → **12 pass / 0 fail**.
- E2E `ticket8.spec.ts` **not run** (needs Playwright + live server + `.dokan-port` restore). The `.dokan-port` tracked file is currently byte-clean per `git status`.

### Residual risks
- `PaymentPanel` invalidates `invoicesList` with `queryKey({ input: {} })` while the list page builds its query with `{ input: { kind?, status? } }`; if oRPC keeps `undefined` fields the /invoices list may not refetch post-payment (mirrors the existing `sale.tsx` pattern; TanStack refetch-on-focus mitigates). Low severity, follow-up.
- Pre-existing `tError` fallback renders literal `"UNEXPECTED"` for unknown keys (cosmetic).
- Inherited: 200-row `/invoices` list cap, no `payments(invoice_id)` index / note length cap, no backfill of pre-change initial payments — all documented as deferred in `08-design.md` Risks section.
- e2e not executed in this review pass.

**No blockers found.**

---

# Round-2 spec re-check (full)

All evidence is in hand. Here is my review.

---

## Review — Issue #8 Payments (High-assurance money math), HEAD bb128f4 vs base af0c7a3

Scope inspected: `git diff af0c7a3...HEAD -- apps/ packages/ tests/` (12 files, +1155/−5), `.scratch/implementation/08-design.md`, plus the transaction/connection internals needed to verify atomicity claims. Read-only; no files modified.

### Criterion-by-criterion verdict (all MET)

**criterion — partial payment reduces remainingAmount — MET**
- Code path: `apps/api/src/rpc/router.ts:543-568` (`invoicesPay` → `insertPayment` → `applyPaymentToInvoice`); the recompute is a single conditional `UPDATE invoices SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ? WHERE id = ? AND remaining_amount >= ?` at `apps/api/src/store/drizzle-store.ts:615-626`.
- Test: `apps/api/src/rpc/router.test.ts:1206-1219` — SALE invoice 800, pays 300 → `paidAmount` 300, `remainingAmount` 500, history length 1; re-read via `invoicesGet` proves persistence. Passed in my run.

**criterion — overpay refused with exact clear error; boundary exact-remaining OK, +1 DA refused — MET**
- Exact-remaining passes: `router.test.ts:1242-1248` — amount 800 on remaining 800 → remaining 0, invoice listed under `status: "PAID"`.
- +1 refused: `router.test.ts:1250-1269` — amount 801 → message contains `PAYMENT_EXCEEDS_REMAINING`; asserts nothing persisted (payment count, paid, remaining, and 0 `PAYMENT_RECORDED` rows).
- Server key + Arabic copy: `apps/web/src/lib/i18n.ts:254` `PAYMENT_EXCEEDS_REMAINING: "المبلغ يتجاوز المتبقي من الفاتورة"` (surfaced via `tError` for server errors, `i18n.ts` diff).
- Boundary enforced twice: JS fast-fail read (`router.ts:548-551`) + authoritative statement-level guard (`applyPaymentToInvoice` returning false → rollback + same key, `router.ts:552-556`). Client-side mirror: `apps/web/src/pages/invoice.tsx:25-30` (`paymentAmountError`), unit-tested at `invoice.test.tsx:127-137` (exact accepted, +1 → `EXCEEDS`).

**criterion — multiple payments accumulate — MET**
- Test: `router.test.ts:1222-1239` — 200 + 250 → `paidAmount` 450, `remainingAmount` 350, `payments.map(amount)` `[200, 250]` in recording order with CASH then BANK; store-side ordering even within one second covered by `apps/api/src/store/drizzle-store.test.ts` ("accumulates instalments and returns history in insertion order even within one second", PASS in my run) via tiebreak `orderBy(payments.paidAt, sql\`rowid\`)` (`drizzle-store.ts:641-643`).

**criterion — full history on invoice screen — MET**
- `apps/web/src/pages/invoice.tsx:90-116` — `PaymentPanel` renders the complete `invoice.payments` array in a `pmt-history` table (row per payment: date, amount, method, note), `pmt-empty` state when none, testids `invoice-total/paid/remaining`.
- Tests: `invoice.test.tsx:166-186` (empty state, ordered rows with amount+method); e2e `tests/e2e/ticket8.spec.ts:64-99` — history grows 0 → 1 → 2 rows in recording order, remaining 900 → 600 → 0.
- Note: creation-time payment rows also appear in history (see scope decision below), e.g. PURCHASE test asserts history `[200, 400]` including the initial 200.

**criterion — each later payment logs PAYMENT_RECORDED — MET**
- Code path: `router.ts:558-561` — `insertActivity({ type: "PAYMENT_RECORDED", summary: "تسجيل دفعة <amount> دج على <invoiceNumber>", ref })` inside the same unit.
- Test: `router.test.ts:1222-1239` — exactly 2 records for 2 payments, `ref === invoice.id`, summary contains `invoiceNumber`. Atomicity interplay proven at `router.test.ts:1313-1363` (audit failure → payment, recompute, and activity all roll back).
- E2e: `ticket8.spec.ts:100-108` — activity screen filtered to "تسجيل دفعة" rows for the number shows exactly 2.

**criterion — Arabic RTL UI — MET**
- Base already RTL: `apps/web/index.html:2` `<html lang="ar" dir="rtl">` (verified at HEAD).
- All new ticket-8 UI strings are Arabic (`i18n.ts:213-257`); e2e asserts the exact Arabic overpay message `"المبلغ يتجاوز المتبقي"` is shown and no wire call is made (`ticket8.spec.ts:73-82` — request counter proves `invoicesPay` never reached the server for the overpay attempt).

**criterion — BOTH sale and purchase payable — MET**
- PURCHASE: `router.test.ts:1288-1301` — PURCHASE invoice total 600 with initialPaid 200, later payment 400 → `paidAmount` 600, `remainingAmount` 0, history `[200, 400]`. SALE is the subject of nearly every other test. Both kinds share one `invoicesPay` path (kind-agnostic) and one list screen with a kind filter (`apps/web/src/pages/invoices.tsx:24-48`).

**criterion — atomicity insert + recompute + activity in one transaction — MET**
- `router.ts:543-568`: one `withTransaction` unit = read detail → `insertPayment` → `applyPaymentToInvoice` → `insertActivity` → re-read; any throw (incl. the DB refusing the UPDATE) → whole unit ROLLBACK.
- Transaction machinery: `drizzle-store.ts:519-544` drives explicit `BEGIN`/`COMMIT`/`ROLLBACK` on the single raw bun:sqlite connection (`db/connection.ts`), serialized via the store queue; `applyPaymentToInvoice` issues its raw UPDATE on that same connection, so it joins the open unit — no separate connection drift.
- Rollback test: `router.test.ts:1313-1363` (`rolls the payment back when the audit insert fails`) — after forced `insertActivity` throw: paid 0, remaining 800, 0 payment rows, 0 activities.
- Concurrency: `router.test.ts:1364-1382` — two concurrent 600-payments → exactly one lands, winner sees 600/200, loser gets `PAYMENT_EXCEEDS_REMAINING`; `drizzle-store.test.ts:838-860` — a second store/connection cannot apply an instalment against stale remaining.

**Scope decision (creation-time payments audited by SALE_CREATED/PURCHASE_CREATED) — documented and implemented as designed**
- Design doc `.scratch/implementation/08-design.md` ("Scope decision (recorded)" section) states creation-time money is audited by the create transaction only.
- Code: `router.ts:430-443` (SALE) and `507-520` (PURCHASE) insert the initial payment row + log only `SALE_CREATED`/`PURCHASE_CREATED`; no `PAYMENT_RECORDED` at creation. This is a deliberate one-financial-fact-one-log-entry rule, not an omission.

### Findings (severity 1–10)

- **Note (severity 2)** — `apps/web/src/pages/invoice.test.tsx`: test run emits React `act(...)` warnings (likely the non-`act`-wrapped submit path). Tests pass; hygiene only. Not a blocker.
- **Note (severity 2)** — Web test convention: `apps/web/bunfig.toml` preloads happy-dom, so web tests only pass when run from `apps/web`. Running the same file from the repo root fails with `document is not defined` (my first run; not a real defect — `bun test` from `apps/web` gives 12 pass / 0 fail).
- **Note (severity 1)** — Raw SQL in the driver adapter `drizzle-store.ts:615-626` is consistent with ADR-0003 and the existing `allocateInvoiceNumber` pattern; it runs on the identical connection that `withTransaction` wraps, so unit atomicity holds.
- **Note (severity 2)** — e2e `ticket8.spec.ts` was reviewed statically, not executed (needs live server + `turborepo`/Playwright infra). Its assertions (request-count overpay block, disabled form at 0, ordered history, 2 audit rows) are consistent with the unit-level evidence and the code.

### Residual risks
1. Design-doc deferred items remain open but are non-blocking and explicitly out of scope: DB-level `CHECK` on paid/remaining needs a SQLite table rebuild; no `payments(invoice_id)` index; no note length cap; `/invoices` inherits the pre-existing 200-row list cap; pre-change PURCHASE invoices with an initial payment carry no payment row (no backfill).
2. E2E not executed by reviewer — recommend a CI run before merging to cover the full UI flow exactly as authored.
3. Money is capped at `Number.MAX_SAFE_INTEGER` (`packages/contracts/src/core.ts:16`), so installments beyond that are schema-rejected (`router.test.ts:1396-1399`, 2⁵³ refused); sums stay float-exact only while every intermediate total is also within the cap — the cap applies to inputs, and recompute is `+/-` on capped wholes, so drift cannot enter through this path.

### Verdict
All eight acceptance criteria are **MET** with passing unit tests (reviewer-executed) and corroborating e2e/static evidence. No blockers.

---

# Round-2 standards re-check (full)

All checks are complete and all targeted test suites pass. Here is the standards re-check report.

---

# Standards Re-Check — Issue #8 (Payments, high-assurance money math)
**HEAD** bb128f4 · **base** af0c7a3 · branch `feat/8-payments` · read-only review (no files modified)

## Review

### Correct (verified with evidence)
- **Whole-DA money everywhere, including new SQL arithmetic.** `dinarsSchema` capped at `Number.MAX_SAFE_INTEGER` (`packages/contracts/src/core.ts:17-19`); the conditional UPDATE adds/subtracts only integers (`paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ?`); the client validator is regex `^\d+$` + `Number.isSafeInteger` (`invoice.tsx:33-39`). No float arithmetic anywhere in the new code (verified: only `+`/`-` on ints; no `/`, `*` non-integer, or `toFixed` in the diff).
- **`applyPaymentToInvoice` atomicity + repo SQL style.** Single-statement conditional UPDATE in `drizzle-store.ts:617-623`; SQLite statement-level atomicity guards the never-overpay boundary even across two connections (tested with a second `openConnection`). Style matches the `allocateInvoiceNumber` precedent (uppercase keywords, `conn.raw.query(...).run(...)` on the same connection used by `withTransaction`'s `BEGIN`/`COMMIT`, `drizzle-store.ts:519-533,543`). The `WHERE ... remaining_amount >= ?` semantics match the fast-fail read (`input.amount > detail.remainingAmount`) — exact-remaining settles, never overpays.
- **Store-seam discipline.** Raw SQL appears only in `drizzle-store.ts` (the driver adapter, per ADR-0003). `port.ts:94-99` declares only the typed seam; `router.ts` talks exclusively to store ports. No raw SQL in the router or web layers.
- **Additive edits to shared files; debts/expenses seams untouched.** `router.ts` changed only by (a) `invoicesPay` replacing `notImplemented`, and (b) an added `insertedPayments` block in both create branches (record a payment row for `initialPaid` — necessary for the history screen; tested at router.test.ts:1331-1334 asserting `payments = [200, 400]`). `router.test.ts`, `i18n.ts` (keys only), `router.tsx` (nav link + 2 routes) all purely additive. No debt (#31) or expense (#9) files or procedures appear in the diff.
- **TDD coverage + RTL conventions.** 13 new API router tests + 2 store tests + 12 web tests + e2e `ticket8.spec.ts`; web tests follow the repo's existing createRoot/act/happy-dom pattern (identical to `purchase.test.tsx`), router-free `PaymentPanel` mirroring `LinkProposalPanel`, all green: **114/114 API, 12/12 web**. Edge coverage is thorough: +1 DA overpay, exact-remaining boundary, already-paid refusal, NaN/0/fractional/`2**53` schema rejects, same-second history ordering (rowid tiebreak), rollback atomicity via a failing `insertActivity` store, and a two-connection overpay test.
- **Anti-slop SAFETY comments** are present on all *risky* new assertions: router.ts `getInvoiceDetail()!` re-read (router.ts:574-576), invoice.tsx `as PaymentMethod` (invoice.tsx:111-113), invoices.tsx `as KindFilter`/`as StatusFilter`, invoice.test.tsx `globalThis` cast and `value")!.set!` (L7, L104), e2e `match(/INV-\d+/)![0]!`, router.test.ts `as Error` casts (L1259, L1280, L1378).

### Findings

| Sev | Location | Finding |
|---|---|---|
| 3 | `apps/api/src/rpc/router.test.ts:1176` | New helper assertion `categories.items[0]!.id` lacks a SAFETY comment (task standard: comment **every** new type assertion). Pre-existing tests use the same idiom uncommented (e.g., L166, L178), so this is conformance-slop, not correctness. |
| 3 | `apps/api/src/rpc/router.test.ts:1377` | `fulfilled[0]!.value` — unchecked array index without a SAFETY comment (its sibling `rejected[0]!.reason as Error` at L1379 *does* have one at L1378; the exclusive-fulfilled invariant is asserted at L1374 but not documented at the assertion). |
| 3 | `apps/api/src/rpc/router.test.ts:1405` | `paid.payments[0]!.note` — null-assertion without a SAFETY comment (the settled-payment invariant is asserted above, but the comment is missing). |
| 3 | `apps/web/src/pages/invoice.test.tsx` (~L130-166) | Three `host.querySelector<HTMLInputElement>(...)!` sites ("blocks an overpay…", "submits a valid instalment…", "locks the form…") lack SAFETY comments. |
| 1 | `apps/api/src/rpc/router.test.ts:1382` | The concurrent-payment test opens at column 0 (`it("two concurrent payments…"`) — indentation breaks the describe block's style. Cosmetic only. |

### Notes
- **SALE-branch behavior addition** (`router.ts:428-436`): invoice creation with `initialPaid > 0` now persists a payment row; previously only PURCHASE set `paidAmount` with no row. Intentional and design-documented (scope decision + "no backfill"); covered by tests. Not a violation.
- **Test-run environment nuance:** `invoice.test.tsx` requires the happy-dom preload configured only in `apps/web/bunfig.toml`; running `bun test` on that file from the repo root fails with `document is not defined`. From `apps/web` it passes (12/12). This is pre-existing infra scoping (sale/purchase web tests share it), not a defect of this change — CI must run web tests from `apps/web`.

- **Blocker:** none.

## Residual risks
- No DB-level `CHECK` on `paid/remaining` columns (a SQLite table rebuild would be required; ALTER cannot add CHECK) — deferred, documented in the design.
- Legacy pre-change invoices with an initial payment show `paidAmount > 0` with an empty payments history (no backfill) — cosmetic mismatch on the new detail screen, documented as deferred.
- `/invoices` list inherits the pre-existing 200-row cap; `payments(invoice_id)` index deferred (scale nicety).
- Cross-process overpay protection rests on SQLite statement-level atomicity of the single UPDATE — validated by the two-connection test in `drizzle-store.test.ts`.
