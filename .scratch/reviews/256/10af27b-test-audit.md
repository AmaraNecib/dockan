# #256 / PR #269 — TEST-AUDIT lens, round 3

- **Scope:** tests added/changed by `git diff 911ad509..10af27b` (base = round-2 tip, HEAD = `10af27b`).
- **Production paths read:** `apps/api/src/rpc/router.ts` (create + accept), `apps/api/src/store/{port,drizzle-store}.ts`,
  `apps/api/src/db/schema.ts`, `apps/api/src/lib/schema-version.ts`, `packages/contracts/src/core.ts`,
  `apps/web/src/pages/invoice.tsx` (`ReturnsPanel`), `apps/web/src/lib/i18n.ts`.
- **Test files audited:** `apps/api/src/lib/return-calculations.test.ts`, `apps/api/src/rpc/router.test.ts`,
  `apps/api/src/store/drizzle-store.test.ts`, `apps/api/src/store/pagination-store.test.ts`,
  `apps/web/src/pages/invoice-returns.test.tsx`, `apps/web/src/pages/returns.test.tsx`,
  `apps/web/src/lib/return-voucher{,-view}.test.tsx`, `tests/e2e/returns.spec.ts`.
- **Commands I ran (this lane, read-only):**
  - `git diff 911ad509..10af27b --stat` + per-file diffs (tests + production).
  - `cd apps/api && bun test src/lib/return-calculations.test.ts src/lib/schema-version.test.ts` → **49 pass / 0 fail**.
  - `grep` for the removed/added i18n keys, for migration-test precedent, and for which store `router.test.ts` uses.
- **Not run:** the ablation table in `.scratch/reviews/256/round3/README.md` was *not* re-executed — every row needs a
  source edit, and this lens is no-edit/no-commit. The README does record exact commands and red-state messages for
  findings 1, 3, 5 and before/after e2e artifacts for finding 2, which satisfies the provenance rule of
  `2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims.md` in form; the raw red outputs were not re-derived
  by me (see Residual risks).

## Verdict

**Adequate with gaps.** Findings 1, 2 and 5 have genuinely discriminating tests (verified non-vacuous by reading the
assertions against the production branch they must fail on). Finding 3 is guarded at both the button and the handler, and
the block is asserted (no request recorded) rather than inferred. Two real gaps remain: the **schema-v6 upgrade path for
an old database has no test at all** (the repo has explicit precedent for exactly this kind of test on the two previous
`returns` columns), and **finding 4's i18n fix is unprotected — a revert leaves the whole suite green**.

## MUST-FIX

### M1 — P1 — no test covers the schema-v6 upgrade path (`returns.spreads_across_invoices` on an old database)

- **Where:** `apps/api/src/store/drizzle-store.ts:1038-1043` (hunk `@@ -1034,6 +1035,13 @@`) adds
  `if (rows.length > 0 && !names.has("spreads_across_invoices")) { conn.raw.exec("ALTER TABLE returns ADD COLUMN spreads_across_invoices INTEGER NOT NULL DEFAULT 0") }`;
  `apps/api/src/db/schema.ts:156-160` and `:438` add the column to the drizzle table and to `SCHEMA_DDL`.
- **What exists:** the only diff-level test change in `drizzle-store.test.ts` is `spreadsAcrossInvoices: false` added to
  **13 existing insert fixtures** (`:1890, :1927, :1948, :1975, :1995, :2109, :2147, :2165, :2180, :2195, :2234, :2295, :2352`).
  That is a type fix, not coverage: every one of those fixtures is `false`, so a `toReturn`/insert mapping hardcoded to
  `false` would still pass all of them.
- **Why it is a gap:** the repo already treats "old database gains a `returns` column" as a first-class behaviour and tests
  it twice — `drizzle-store.test.ts:414` *"migrates a pre-#68 returns table: adds debt_applied and marks legacy rows fully
  applied"* and `:2053` *"upgrades a pre-settlement returns table: adds cash_paid_out/debt_offset and backfills legacy rows
  as all-cash"*, both asserting through `PRAGMA table_info(returns)`. The third column of the same table ships without its
  analogue. Nothing in the suite would go red if the `ALTER TABLE` block were deleted, if `DEFAULT 0` were changed to
  `DEFAULT 1` (which would silently re-introduce the exact spill this round closes for every pre-v6 row), or if the column
  were added to the DDL but not the drizzle table. The v6 bump itself is fine — `schema-version.test.ts` is written
  version-relative (`CURRENT_SCHEMA_VERSION ± 1`) and passed 49/0 when I ran it — but that only proves the *gate*, not the
  *column*.
- **Smallest fix (mirror `:2053`):**
  ```ts
  it("upgrades a pre-#256 returns table: adds spreads_across_invoices defaulting to own-invoice-only", async () => {
    const legacy = makeLegacyConnection();            // same helper the :2053 test uses
    legacy.raw.exec(`CREATE TABLE returns (... cash_paid_out, debt_offset ...)`); // v5 shape, no spreads column
    legacy.raw.exec(`INSERT INTO returns (...) VALUES (...)`);                    // one legacy row
    const store = createDrizzleStore(legacy);
    const cols = legacy.raw.query("PRAGMA table_info(returns)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("spreads_across_invoices");
    expect((await store.getReturnById(legacyRowId))?.spreadsAcrossInvoices).toBe(false); // DEFAULT 0 == pre-#256 rule
  });
  ```
  Also worth one line: an **empty** legacy `returns` table (zero rows) must still gain the column — `rows.length > 0` reads
  `PRAGMA table_info`, not row count, but that invariant is exactly what the two existing migration tests pin for their own
  columns and is currently unpinned here.

### M2 — P2 — finding 4 (i18n direction fix) has zero regression protection

- **Where:** `apps/web/src/lib/i18n.ts:927` — `supplierReturnDefaultDebt` changed from `"…الدين الذي لنا عند المورّد…"` to
  `"الافتراضي: يُخصم من الدين الذي علينا للمورّد (لا نقد)"`. Consumed only at
  `apps/web/src/components/parties/supplier-return-panel.tsx:268`.
- **Evidence of the gap:** `grep -rn "supplierReturnDefaultDebt\|علينا للمورّد" apps/web/src` returns **only** the resource
  and the component — no test file references the key or the corrected wording, and the old wording (`لنا عند المورّد`) is
  referenced nowhere either. Revert the string and the suite stays green (`apps/web: 1288 pass` would be unchanged).
- **Why it matters:** this is the one finding whose whole content is a rendered string; the direction is the substance
  (who owes whom). An unprotected text fix is the cheapest kind of silent regression.
- **Smallest fix:** in the supplier-return-panel test (or a new 3-line test) assert the literal, not the key —
  ```ts
  expect(host.textContent).toContain("يُخصم من الدين الذي علينا للمورّد");
  expect(host.textContent).not.toContain("لنا عند المورّد");
  ```
  Asserting through `t("supplierReturnDefaultDebt")` would be worthless here (same source on both sides — see H3).

### M3 — P2 — acceptance boundary for the new guard is only tested at one point

- **Where:** `apps/api/src/rpc/router.ts:1770-1781` — `if (left > 0 && existing.spreadsAcrossInvoices) { … spread … }`.
  New tests: `router.test.ts:~3719` (explicit: own 300 → paid 100 → own 200, `left = 100` stays unapplied, `debtApplied 200`)
  and `router.test.ts:~3751` (defaulted: same shapes, `left = 100` spreads, `debtApplied 300`).
- **Both tests sit at the same interior point** (`0 < own < debtOffset`). The two boundaries the `&&` actually splits are
  untested:
  1. **`left === 0`** (accepted when the invoice is untouched): no spill even for a defaulted return; assert the party's
     other invoice is untouched — this is the branch the old `if (left > 0)` already handled, and it is what fails first if
     someone inverts the new condition.
  2. **`own === 0`** (defaulted return whose own invoice was paid off before acceptance): `left === debtOffset`, so the
     *entire* offset must land on the other invoice. Pay 300 on `invoiceB` (not 100) in the `~3751` fixture and assert
     `debtApplied === 300`, `invoiceB.remainingAmount === 0`, `invoiceOther.returnCreditAmount === 300`.
  3. **Missing rows:** a defaulted return with `left > 0` and **no other open invoice** for the party (delete
     `invoiceOther`): acceptance must succeed with `debtApplied === own` and no error. Untested today.
- **Smallest fix:** the three cases above are 3 extra `expect`s on two copied fixtures; case 2 is the one-line change
  `amount: 100 → 300` in the existing defaulted test plus its two assertions.

## NICE-TO-HAVE

- **H1 — P2 — finding 3 tests the *failed* party read, not the in-flight one.** `invoice-returns.test.tsx:~1030-1050`
  sets `failPartyDebt = true` (`:190` fixture flag, reset at `:191`), so `partyDebtQuery.data === undefined` via
  `isError`. Production's actual window is the *loading* state (same `data === undefined` branch), and the 8 pre-existing
  tests needed a new `await flushAsync()` (`:384, :484, :532, :543, :584, :597, :625`) precisely because the panel now
  blocks until that read settles. A test that renders, types, and submits **without** awaiting must assert the same block
  (disabled + `returnsSplitUnknown`), or the guard is pinned only in the error path.
- **H2 — P2 — the new guard makes 8 existing tests order-sensitive through a bare `await flushAsync()`.**
  `invoice-returns.test.tsx:384` etc. now depend on the mocked `debtsByParty` promise resolving inside one 20 ms act flush
  (see `2026-08-24-deterministic-timing-tests.md`). Put the wait in a shared helper (e.g. `renderPanelSettled()` or an
  `await flushAsync()` inside `renderPanel`) so a future test cannot be silently blocked by the new guard and report
  `returnsSplitUnknown` instead of its own subject.
- **H3 — P2 — overfitting: the assertion compares the render to the key it renders from.**
  `invoice-returns.test.tsx:1046` — `expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toBe(i18n.t("returnsSplitUnknown"))`.
  If the key were missing or renamed, `i18n.t` returns `"returnsSplitUnknown"` and the component renders the same raw key,
  so the assertion still passes — it cannot catch a broken key, and it moves with the string. Same class at
  `:1042` (`…toContain(i18n.t("returnsSplitAllDebt"))`) and `:1040`/`:1043` (`toContain("900")`, `toContain("0")`).
  Fix: assert literals, or add `expect(text).not.toBe("returnsSplitUnknown")`; for the select use `toBe(...)`/the trigger's
  value rather than `toContain` (a trigger that ever renders its option labels inline would make `toContain` vacuous).
- **H4 — P3 — finding 2's unit test has no ablation row.** The README's ablation table covers findings 1, 3, 5; the
  `displayedSettlement` fix is proved only by the e2e before/after on `911ad509` (screenshots + `round3-before.webm`,
  where the select reads «اختر طريقة التسوية»). That is real discrimination evidence, but it lives in artifacts rather
  than in a re-runnable row; add "restore the mirror `useEffect`" to the table with its command and expected failure.
  I could not re-run it (no-edit lens).
- **H5 — P3 — the same-class latent line `setSettlement("CUSTOM")` (invoice.tsx:~904) is not pinned by any new test.**
  The new test reaches an explicit choice through `pickSettlement` (`onValueChange` sets both states). The custom-cash
  *edit* path (typing into `returns-cash`/percentage without touching the select) is what the new line fixes. Confirm an
  existing test covers it (with `settlementChosen` true and no `setSettlement`, `displayedSettlement` would be `null` and
  the preview would blank), otherwise add the 5-line test.
- **H6 — P3 — concurrent accept is still unexercised.** `router.test.ts` has the sequential #68 case
  ("applies accepted offsets sequentially, capping each against the debt still owed"), but no `Promise.all` double-accept
  (same return twice, or two returns on the same invoice) even though acceptance now branches on an extra stored field and
  re-reads the party's open invoices. Pre-existing gap, not introduced here; one `Promise.all([accept, accept])` with a
  single-relief assertion would close it.
- **H7 — P3 — `returnSchema.spreadsAcrossInvoices` is required (`packages/contracts/src/core.ts:650`), so a skew between
  a cached older web bundle and the upgraded api fails schema parse rather than defaulting. No test pins the tolerance
  (`.optional().default(false)` vs required). Design call, but flag it: the field is never rendered by the client.
- **H8 — P3 — duplicated coverage.** The unit test at `invoice-returns.test.tsx:~1004` and the e2e at
  `tests/e2e/returns.spec.ts:355-419` assert the same finding-2 behaviour. Keep both (the e2e is the real-screen proof and
  the video artifact depends on it), but they are the round's only same-behaviour pair and worth naming as such.

## What is already good (verified, not assumed)

- **F1 explicit-spill test is non-vacuous.** `router.test.ts:~3719`: the invoice the owner never named must show
  `remainingAmount 400` / `returnCreditAmount 0`. With the guard reverted to `if (left > 0)` the 100 genuinely lands
  there, so the assertion discriminates (matches the README's recorded red state: *Expected 200, Received 300*). The
  fixture also makes `invoiceOther` the **older** invoice, so a leak cannot be excused by ordering.
- **The `true` mapping is covered end-to-end.** `router.test.ts:21,56` builds the router over `createDrizzleStore`, so the
  defaulted-return test at `~3751` proves `insertReturn`/`toReturn` round-trip `spreadsAcrossInvoices === true` — the
  fixture-only `drizzle-store.test.ts` changes (M1) are not the only evidence for the mapping.
- **F3's block is asserted, not inferred** (`invoice-returns.test.tsx:~1044`): `expect(lastCreateInput).toBeNull()` after a
  **raw `form.dispatchEvent("submit")`**, plus the disabled-button assertion — this is exactly the
  `2026-10-12-linked-amount-and-settlement.md` round-2 rule ("a disabled button is not the guard"), and the trailing
  `expect(lastCreateInput?.cashPaidOut).toBe(0)` still fails if the second submit is blocked too (no vacuous `undefined`).
- **F5's fixture change is the right one.** `return-calculations.test.ts:378-390`: `INV-9999` vs `INV-10000` is the only
  digit-width pair where numeric and lexical orders disagree, so the assertion `toEqual(["b","c"])` now fails on a
  comparator that drifted to strings — the previous `INV-0009`/`INV-0010` pair agreed under both, which is why the old
  test passed against the very bug its comment named. I re-ran the file: 49 pass / 0 fail (`return-calculations` +
  `schema-version`).
- **The schema bump itself is safe for the gate tests.** `schema-version.ts` v6 + the doc comment; `schema-version.test.ts`
  is version-relative, no hardcoded `5` needed updating, and it passes.

## Residual risks / not verified

1. The ablation table (`README.md`) was not re-executed here (no-edit lens); its red-state messages are plausible from
   reading but are inherited in provenance, not reproduced by me on this HEAD.
2. `derivedRefundSplit` / `returnSettlementDefault` internals (in `@dokan/contracts`) were read only through call sites;
   I did not confirm which `(returnValue, invoiceDebt, partyDebt)` triples yield `derivedSplit === null` other than the
   `SPLIT + unknown tab` case M3/H1 exercise.
3. Whether `setSettlement("CUSTOM")` (H5) is already pinned by a pre-existing custom-split test was not resolved —
   needs one grep/run in the web lane.
