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

## Test audit — 3 lanes + round-2 verification

### Edge case hunter — key findings and resolutions
1. (sev 7) No concurrency test — RESOLVED: "two concurrent payments serialize and
   never overpay" router test (Promise.allSettled) + store cross-connection
   applyPaymentToInvoice refusal test.
2. (sev 5) UNPAID/PARTIAL transitions and zero-total edge untested — RESOLVED:
   status-transition test + zero-total-is-PAID store test + UNPAID guard.
3. (sev 4) dinarsSchema unbounded — RESOLVED: .max(Number.MAX_SAFE_INTEGER) + 2**53 schema test.
4. (sev 4) PURCHASE flow half-attested — API fully covered; E2E stays SALE-only
   (accepted residual, documented).
5. (sev 3) SALE initialPaid + later payments untested — covered via PURCHASE
   mixed-history test + ticket-30's sale-with-payment surface.
6. (sev 3) PAYMENT_RECORDED summary amount unasserted — ref+number asserted; E2E
   literal entries asserted.
7. (sev 3) Web validator spellings — RESOLVED (digit regex).
8. (sev 2) note "" vs null — RESOLVED (trim to null) + API test.
9. (sev 2) malformed invoiceId vs INVOICE_NOT_FOUND — different error class by
   design; UI maps via tError; accepted.
10. (sev 2) stale-remaining server-refusal UI path — RESOLVED: PaymentPanel test
    drives PAYMENT_EXCEEDS_REMAINING through tError to the Arabic message.
11. (sev 2) non-null re-read — sound (same-unit read); documented.
12. (sev 2) same-second ordering e2e weakness — accepted layering (store test owns it).
13. (sev 2) 200-row list cap — pre-existing, deferred.
14. (sev 2) page-component layer untested — RESOLVED: PaymentPanel + 7 component tests.

### Coverage analyst — acceptance mapping (all MET with passing tests)
Partial payment reduces remaining / overpay +1 DA exact error / accumulate /
full history / PAYMENT_RECORDED per later payment / Arabic RTL / SALE+PURCHASE
payable / one-transaction atomicity / boundary exact-remaining accepted +1 refused.

### Quality reviewer — findings and resolutions
Concurrency test added; e2e wire-count proof (overpay sends NOTHING) added;
web mock latent trap fixed (options merged incl. onSuccess/onError);
INV-\d{4} made width-agnostic; EOF newlines added; duplicate setup preamble
is suite convention.

### Round-2 verification (bb128f4)
Item-by-item: all 12 findings RESOLVED (incl. reviewer-executed runs of the
cross-connection and concurrency tests). All acceptance criteria re-mapped MET.

### Round-3 delta (b432496)
Exact-key invalidation for the mounted detail read (E2E-proven); prefix keys
best-effort for list/activity. Rebase merged PRs #45/#46 additively; full battery
green at final HEAD (14/14 e2e).

---

# Edge case hunter (full)

# Edge Case Hunt — Issue #8 (Payments on invoices, instalments)

Reviewed: `git diff af0c7a3...HEAD` (commit `d625b93`), source at HEAD, tests in `router.test.ts`, `drizzle-store.test.ts`, `invoice.test.ts`, `tests/e2e/ticket8.spec.ts`, plus `08-design.md`, `packages/contracts/src/core.ts`, `apps/api/src/db/schema.ts`. **No files modified.**

## Verdict

The implementation is strong and matches the design doc exactly. **No blockers, no 🔴.** The suite covers 11 router cases, an atomicity rollback, the same-second ordering tie-break, the pure web validator, and a full SALE e2e. The gaps are concentrated where money code needs the most paranoia: **concurrency (untested entirely), status-filter classification, and numeric-bound validation.**

## Findings (severity 1–10)

| # | Sev | Risk | Where | Finding |
|---|-----|------|-------|---------|
| 1 | 7 | 🟠 | `apps/api/src/rpc/router.ts:539-560`, `apps/api/src/store/drizzle-store.ts:182-186` | **Concurrent pays — zero tests.** The entire high-assurance claim ("no check-then-act race") rests on the single in-process job queue. No test fires two `invoicesPay` calls concurrently (e.g. `Promise.all` of 3×400 against 800 remaining → exactly two succeed, paid stays 800, remaining ≥ 0). The queue is per-store-instance (module-level `jobQueue`), and the code itself contemplates multi-process opens at setup — a second process would not serialize through this queue and two deferred SQLite transactions could both read `remaining=800` before either writes (busy/lock behavior then decides the outcome). A regression here silently overdraws `paidAmount > totalAmount` — the exact class of bug this ticket exists to prevent. Highest-value missing test. |
| 2 | 5 | 🟠 | `apps/api/src/store/drizzle-store.ts:643-645` | **UNPAID/PARTIAL status transitions never tested.** Only `status: "PAID"` is asserted (router test "exact-remaining … listed PAID"). The party-line filters `UNPAID` (`remaining = total`), `PARTIAL` (`0 < remaining < total`) are SQL conditions — after the first £300 instalment the invoice should flip to PARTIAL, and after settling it should leave PARTIAL. E2E checks only remaining text on the invoice card, never the filters. Also untested edge: an invoice with `totalAmount = 0` (all-zero lines / full discount) classifies as PAID with `remaining = 0` despite never being paid. |
| 3 | 4 | 🟡 | `packages/contracts/src/core.ts:16,414` | **No upper bound on `dinarsSchema` (`z.number().int().min(0)`).** `Number.isInteger(1e308)` is `true`, so astronomically large amounts pass zod; the overpay guard (`router.ts:551`) refuses them harmlessly, but `detail.paidAmount + input.amount` (`router.ts:560`) on values > 2⁵³ loses integer precision and can exceed SQLite i64 (~9.2e18), throwing mid-transaction. For high-assurance money math, add a `Number.isSafeInteger` refine/`.max()` and a test with a near-2⁵³ amount. |
| 4 | 4 | 🟡 | `tests/e2e/ticket8.spec.ts` (SALE only), `router.test.ts` PURCHASE block | **PURCHASE half-attested.** Overpay refusal is only tested on SALE (PURCHASE tests settle-exact only); and there is no PURCHASE e2e at all — the list/detail/pay screen for a PURCHASE invoice is unproven in the UI despite "BOTH kinds payable" in the acceptance. |
| 5 | 3 | 🟡 | `apps/api/src/rpc/router.ts:433` (SALE initialPaid payment row) | **SALE `initialPaid > 0` + later payments never tested.** The mixed history (creation-time payment row + later instalments) is only exercised for PURCHASE; the recompute via `detail.paidAmount` including the initial row is untested for SALE. |
| 6 | 3 | 🟡 | `apps/api/src/rpc/router.ts:564` | **PAYMENT_RECORDED amount in summary never asserted.** Tests check `ref` + invoice-number containment only (and the e2e checks the literal "تسجيل دفعة" prefix); a wrong amount formatted into the summary would pass everything. |
| 7 | 3 | 🟡 | `apps/web/src/pages/invoice.tsx:23-27` | **Web validator accepts non-decimal spellings.** `Number("1e3")=1000`, `Number("0x10")=16`, `Number("12.")=12`, `Number(" 12 ")=12` all pass `paymentAmountError` — the INVALID contract implied by the unit tests is narrower than the implementation. Also `Number("9007199254740993")` silently rounds to …992, so the client can accept a value the user didn't type before the server's exact comparison. |
| 8 | 2 | 🟡 | `apps/api/src/rpc/router.ts:555`, `invoice.tsx` note cell | **`note: ""` vs `null`.** Zod allows an empty-string note, and `input.note ?? null` stores `""`; the UI renders `payment.note ?? "—"` — an empty cell instead of the dash. Web sends `undefined` after trim, so only API consumers hit this; normalize or document. |
| 9 | 2 | 🟡 | `packages/contracts/src/core.ts:15` | **Malformed invoiceId (non-UUID) hits zod "Input validation failed", not `INVOICE_NOT_FOUND`** — a different error class than the tested missing-invoice case; unasserted. |
| 10 | 2 | 🟡 | `apps/web/src/pages/invoice.tsx` (onError/tError path) | **Stale-remaining UI path untested.** If remaining falls server-side between render and submit (second tab pays), the client passes its check and the server refuses with `PAYMENT_EXCEEDS_REMAINING` → `tError` renders the Arabic message. Never tested at unit or e2e level — and note the e2e overpay step is actually caught *client-side*, so the server-refusal rendering path isn't what the e2e proves. |
| 11 | 2 | 🟡 | `apps/api/src/rpc/router.ts:569` | **`(await tx.getInvoiceDetail(detail.id))!` non-null assertion.** Today true only because no feature deletes invoices; the re-read bypasses the established `INVOICE_NOT_FOUND` pattern. A future delete feature turns this into a silent null-crash. |
| 12 | 2 | 🟡 | `drizzle-store.ts` `getInvoiceDetail` (`orderBy paidAt, rowid`) | **E2E ordering assertion is weak:** `history.nth(0)` covers seconds-separated entries (distinct `paidAt`); only the store-level test pinpoints the same-second rowid tie-break. Fine layering, but the display-order guarantee for back-to-back same-second instalments is attested only at the store seam. |
| 13 | 2 | 🟡 | `drizzle-store.ts` `listInvoices` (`.limit(200)`) | Pre-existing, now user-visible: >200 invoices are silently truncated on the new `/invoices` page with no pagination or notice. |
| 14 | 2 | 🟡 | `apps/web/src/pages/invoice.test.ts` | The page-component layer is not unit-tested at all (rpc module mocked; only the pure `paymentAmountError` function is exercised). Form disable/enable, error state, and reset behavior rest entirely on the single e2e. |

## What's already good (evidence)

- Exact-remaining boundary accepted → remaining 0, listed PAID; +1 overpay refused with `PAYMENT_EXCEEDS_REMAINING` and *nothing* persisted (payment row, header, audit all verified unchanged).
- Already-PAID refusal; zod rejects 0/negative/fractional/NaN before the handler.
- Atomicity proven by an injected failing `insertActivity` — payment row, paid/remaining, and audit all roll back (`router.test.ts` "rolls the payment back").
- Accumulation invariant: paid = Σ payments across 200+250 and 200+400(PURCHASE); method default CASH, note null.
- Same-second ordering tie-break pinned at store level (`drizzle-store.test.ts`).
- E2E: full SALE journey endpoint-to-endpoint incl. Arabic overpay message, history order, form lock at remaining 0, and activity-log audit rows.
- Conceptually sound layering: client-side boundary mirrors the server (`paymentAmountError` == handler check), so the UI never ships an overpay.

## Residual risks

- Concurrency behavior is the largest unproven claim (finding 1) — money invariant depends on the in-process serialization queue.
- Status-filter SQL semantics (UNPAID/PARTIAL, zero-total invoices) unverified by any test.
- No upper-bound/safe-integer validation in the money schema.
- PURCHASE UI flow and SALE-with-initial-paid flows lack e2e/API coverage.
- 200-row list truncation silently visible on the new invoices page.

---

# Coverage analyst (full)

All evidence gathered. Here is the coverage analysis.

# Coverage Analysis — Issue #8 (Payments on invoices in instalments)

**Scope reviewed:** commit `d625b93` vs base `af0c7a3` (branch `feat/8-payments`), read-only.
**E2E pay→history flow:** `tests/e2e/ticket8.spec.ts` **fully covers** the user flow: sale created with zero paid → `/invoices` list → open detail → pay 300 (history 1 row, remaining 600) → overpay 601 refused (history stays 1) → settle 600 (remaining 0, history 2 ordered rows, form disabled) → activity log shows two `تسجيل دفعة` rows. All testids it references exist: `sale-quick-stock-add` (sale.tsx:251), `sale-quick-form` (256), `sale-quick-name` (258), `sale-quick-stock` (263), `sale-lines` (270), `sale-total` (280), `sale-save` (283), `sale-saved-number` (233), `activity-table` (activity.tsx:49), `invoices-table`/`invoice-remaining-*`/`invoice-open-*` (invoices.tsx), `pmt-*` + `invoice-remaining` + `invoice-number` (invoice.tsx).

## Acceptance-criterion → test mapping (all criteria covered)

| Criterion | Concrete test(s) |
|---|---|
| Partial payment reduces remainingAmount | `apps/api/src/rpc/router.test.ts:1204-1220` (paid 300, remaining 500, re-read from store persists); `apps/web/src/pages/invoice.test.ts:22-27` (validator accepts below/at-remaining); `tests/e2e/ticket8.spec.ts:60-67` (`invoice-remaining` 900→600) |
| Overpay refused with exact clear error | `router.test.ts:1251-1269` (+1 DA → `PAYMENT_EXCEEDS_REMAINING`, zero writes: no payment row, paid/remaining unchanged, 0 audit rows); `router.test.ts:1273-1285` (any amount on paid invoice refused); web unit `invoice.test.ts:29-35` (EXCEEDS); i18n `apps/web/src/lib/i18n.ts` `PAYMENT_EXCEEDS_REMAINING` + `pmtExceedsRemaining` Arabic texts; e2e `ticket8.spec.ts:69-75` (exact Arabic message) |
| Multiple payments accumulate | `router.test.ts:1222-1239` (200+250=450 paid, remaining 350, ordered `[200,250]`); store seam `apps/api/src/store/drizzle-store.test.ts:807-832` (same-second insertion-order tiebreak); e2e `ticket8.spec.ts:60-85` (two rows, `nth(0)=300`, `nth(1)=600`) |
| Full history visible on invoice screen | `router.test.ts:1204` history appended + fresh `invoicesGet` returns it; `drizzle-store.test.ts` `getInvoiceDetail` chronological order; UI `apps/web/src/pages/invoice.tsx` renders paidAt/amount/method/note table (`pmt-history`); e2e `ticket8.spec.ts:54-58` (empty state `pmt-empty`) and 60-85 (grows 0→1→2 in order) |
| Each payment logs PAYMENT_RECORDED | `router.ts` `insertActivity({ type: "PAYMENT_RECORDED", … })` inside the unit; `router.test.ts:1222-1239` (exactly 2 records, `ref` = invoice, summary contains number); `router.test.ts:1267-1268` (overpay → 0 records); e2e `ticket8.spec.ts:87-94` (activity table shows 2 `تسجيل دفعة` rows w/ number) |
| Arabic RTL UI | `apps/web/index.html:2` `<html lang="ar" dir="rtl">`; i18n keys all Arabic (invoice.tsx/invoices.tsx full Arabic strings); `dir="ltr"` reserved only for numerals/dates (invoice.tsx date, paidAt) — correct RTL practice; e2e asserts Arabic labels/messages throughout |
| Both SALE and PURCHASE payable | `router.test.ts:1287-1302` (PURCHASE with initialPaid 200 → pay 400 → remaining 0, history `[200,400]`); SALE covered by every other case (1204, 1222, 1241, …) |
| Atomicity: payment insert + recompute + activity in one transaction | `router.ts` — all three calls inside one `store.withTransaction` (overpay check also inside); `router.test.ts:1319-1344` rollback proof (failing `insertActivity` → no payment row, paid/remaining unchanged, no phantom activity); serialization covered by existing `transactions > serializes concurrent units` store tests (passed) |

## Tests run

- `bun test apps/api/src/rpc/router.test.ts apps/api/src/store/drizzle-store.test.ts --timeout 30000` → **passed** (108 pass, 0 fail, 425 expects) — includes all 11 ticket-8 API cases + store history test + transaction serialization.
- `bun test apps/web/src/pages/invoice.test.ts --timeout 30000` → **passed** (5 pass, 0 fail).
- E2E `ticket8.spec.ts` → **not run** (read-only review; requires playwright browsers + shared-DB reset). Flow verified by static affordance inspection.

## Review

- **Correct:** Guard is inside the transaction (router.ts) — no check-then-act race under the serialized queue; boundary semantics match the contract (`amount > remaining` rejects, exact-remaining settles to 0); overpay writes nothing (verified in test 1251); money stays integer DA; validator mirrors API boundary client-side; e2e is the full pay→history→audit journey.
- **Fixed:** nothing (read-only review; no files modified).
- **Blocker:** none. Every acceptance sub-criterion maps to a concrete passing test.

**Findings (severity 1–10, lower = less severe):**

- **3 — docs drift:** `.scratch/implementation/08-design.md` calls the exported validator `paymentInputInvalid`; implementation/tests export `paymentAmountError` (`apps/web/src/pages/invoice.tsx:17`, `invoice.test.ts:14,19`). Scratch doc only — no code impact.
- **2 — storage coupling:** `apps/api/src/store/drizzle-store.ts:619` changed history ordering to `orderBy(payments.paidAt, sql`rowid`)` (same-second tiebreak). Works and is tested today, but silently breaks if the `payments` table ever becomes `WITHOUT ROWID` or the store moves off SQLite. Additive comment in the store test documents intent.
- **2 — server overpay message never asserted verbatim in e2e:** `ticket8.spec.ts:69-75` matches `المبلغ يتجاوز المتبقي`, a substring present in **both** the client message (`pmtExceedsRemaining`) and server key (`PAYMENT_EXCEEDS_REMAINING`). The client blocks before the request, so the server-side Arabic path is only exercised at API level (`router.test.ts:1251` checks the raw key). Acceptable, but the exact server string is unverified end-to-end.
- **2 — purchase-payment flow not e2e-covered:** PURCHASE payable verified only at API level (`router.test.ts:1287`). E2E covers SALE only — matches design intent; flag as residual, not a gap.
- **1 — behavior change in `invoicesCreate`:** paid-now purchases now also materialize an initial payment row (`router.ts:507-516`), so payment history includes the initial payment (the PURCHASE test asserts `[200, 400]`). Intentional and consistent with "full history"; no regression (full suite green).
- **1 — atomicity is proven via harness, not a raw process kill:** rollback test (1319) injects a throwing `insertActivity` inside `withTransaction`; true crash-kill mid-commit is approximated by the store serialization tests. Reasonable for this tier.

---

# Quality reviewer (full)

All evidence gathered: diff reviewed, design doc read, all three unit test files run (113 pass / 0 fail in 8s), and the e2e/authority config inspected. Final report follows.

## Review

### Correct — what is already good (with evidence)

- **Meaningful assertions throughout, not "doesn't crash".** Every API test asserts exact numbers: `paid.remainingAmount` toBe(500) after a 300 payment, `payments.map(p => p.amount)` toEqual([200, 250]), activity rows counted by `type`/`ref` and checked for the invoice number in `summary` (router.test.ts:1189-1327). The atomicity test asserts the *absence* of payment rows, no paid/remaining drift, and no phantom `PAYMENT_RECORDED` rows after a forced rollback — a genuine crash-atomicity proof, not a smoke check.
- **Shared-DB isolation is compliant.** router.test.ts uses one file-backed sqlite wiped per `beforeAll` (mkdtemp); the ticket-8 item names (`دفعة-جزئية`, `دفعات-متراكمة`, … `دفعة-ذرية`) are each used exactly once and collide with no other describe in the file (grep confirms "دفعة" appears only inside the ticket-8 block). The store test's `INV-9101` collides with nothing in drizzle-store.test.ts (which uses INV-0001/0002/0003/0100/0101/LEGACY/…). The e2e uses `Date.now()`-stamped category/item names per the rule for the shared wiped-once DB (ticket8.spec.ts:24-25), and `retries: 0` + `workers: 1` matches the suite's wipe→setup→login serialisation.
- **Deterministic ordering — and the fix that makes it true.** The store diff changes the history tiebreak from `orderBy(paidAt, payments.id)` (random UUID → coin-flip ordering for two payments within one second) to `orderBy(paidAt, rowid)` (drizzle-store.ts:619). The same-second case is *deliberately* exercised: drizzle-store.test.ts inserts two payments with one reused `localDateTime()` stamp and asserts [200, 300]. The router tests' [200, 250] and [200, 400] accumulation assertions are now deterministic under this tiebreak. `rowid` on this table is insertion order in practice (UUID TEXT PK = normal rowid table; payments are never deleted).
- **Selectors are non-brittle.** e2e uses `data-testid` throughout (`pmt-amount`, `pmt-history`, `invoice-remaining-*`, `pmt-error`, `pmt-done`); the history locator is re-resolved on each use; row order is asserted via `nth(0)/nth(1)` only after `toHaveCount`.
- **Full-file test run passes:** `bun test` over router.test.ts + drizzle-store.test.ts + invoice.test.ts → **113 pass / 0 fail, 439 expect() calls, 8s**.

### Findings (severity 1–10)

1. **SEV 5 — no concurrency test for two parallel payments on one invoice (the design's core high-assurance claim).** The overpay check living *inside* the serialized `withTransaction` ("no check-then-act race", router.ts:541-550) has no test issuing two concurrent `invoicesPay` calls against the same remaining amount. The suite already has the pattern (`two concurrent creates of the same category resolve as CONFLICT`, and store-level *serializes concurrent units*); ticket 8 leaves the racing path covered only by implication. A regression to check-then-act would pass CI as-is. Residual risk, not a blocker — the rollback test covers crash atomicity, not racing.
2. **SEV 4 — the exact server error and its Arabic mapping are never asserted end-to-end.** The API test string-checks the raw key `PAYMENT_EXCEEDS_REMAINING` (router.test.ts:1261-1266); the e2e overpay step (ticket8.spec.ts:62-65) only ever exercises the *client-side* pre-check message (`pmtExceedsRemaining`), because the form blocks bad amounts before the request is sent. The `PAYMENT_EXCEEDS_REMAINING: "المبلغ يتجاوز المتبقي من الفاتورة"` entry added to i18n.ts is dead from the tests' point of view — a typo in that translation would pass CI. Also, no test verifies the overpay attempt actually sends nothing (a network/request-count assertion would close this).
3. **SEV 3 — web unit mock is a latent trap (drift).** invoice.test.ts:9-12 mocks `invoicesGet` *without* `queryKey`, but invoice.tsx:51 calls `orpc.invoicesGet.queryKey({ input: { id: invoiceId } })` in the mutation's `onSuccess`. The test only imports the module and tests the pure `paymentAmountError`, so it passes today; the moment anyone renders the page or tests invalidation, the missing key throws. Related gap: component behaviour (form disable at remaining=0, error render, history table) has zero unit coverage — e2e is the only render coverage.
4. **SEV 3 — e2e invoice-number regex pins a 4-digit width.** ticket8.spec.ts:46 `match(/INV-\d{4}/)![0]!` silently truncates `INV-10000` to `INV-1000`, which then never matches `data-testid="invoice-remaining-INV-10000"` and fails with an obscure timeout. Fresh wipe per suite resets the counter so it's safe today, but `/INV-\d+/` would remove the assumption.
5. **SEV 2 — duplicated setup preamble.** ticket8.spec.ts:9-21 copies the exact 13-line setup→login block used by all 9 sibling specs instead of a helper. Established suite convention (not newly introduced), but any setup-flow change means touching every spec.
6. **SEV 2 — coverage gaps in e2e:** PURCHASE-invoice instalments are only tested at the API level (router.test.ts:1288-1301), never in the browser; and the e2e never asserts the note/method columns render in the history table. SALE path carries the UI burden.
7. **SEV 1 — cosmetic:** no trailing newline at EOF in router.test.ts, invoice.test.ts, ticket8.spec.ts (git `\ No newline at end of file`).
8. **SEV 1 — note:** `makePaidItem` (router.test.ts:1171-1177) reads `categories.items[0]!`; safe because setup seeds the default category "عام" and earlier describes add more, but it is an implicit ordering dependency — a `bun test -t` filter on the ticket-8 describe alone would still pass thanks to the seed, so this is informational only.

### Blocker

None. Test quality is high for the acceptance surface: instalments accumulate, exact-remaining boundary, +1 overpay refusal with nothing written, already-paid refusal, both kinds payable, `PAYMENT_RECORDED` audit per payment (ref + number in summary), zod rejects non-positive/fractional/NaN, and one-transaction rollback is proven.
