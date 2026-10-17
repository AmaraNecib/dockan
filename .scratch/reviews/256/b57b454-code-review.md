# reviewed SHA b57b454

Scope: final code-review lens on the #256 round-3 fix round (PR #269).
Diff bases: round-2 head `911ad509`, my prior review point `4378574`, FINAL HEAD `b57b454`.
Worktree: `D:/projects/mani-worktrees/fix-256-round3`. Spec: `D:/projects/mani-project/.scratch/sessions/crew/briefs/fix-256-round3.md`.

## Verdict

**PASS — no P0/P1/P2. Ready to merge.** All five Greptile findings at `911ad509` are closed or (N/A) refuted; my two P2 comments of `4378574` are fixed; my third P2 is a correct REFUTATION and I withdraw it.

## (a) `git diff 4378574..b57b454` — my P2s 1 and 2, and "no executable change"

Commit `b57b454` touches exactly 5 files: `README.md` (.scratch), `apps/api/src/db/schema.ts`, `apps/api/src/store/drizzle-store.ts`, `apps/web/src/pages/invoice.tsx`, `packages/contracts/src/core.ts`.

- **P2-1 orphan comments — FIXED.** `invoice.tsx` loses exactly the two lines
  (`// the derived default stays visible until the owner picks: no mirror state,` /
  `// so it cannot outlive the form it belonged to`) at old line 565. The surrounding
  `debtIsCapped` / `cashExceedsCollected` code is untouched. No orphan remains.
- **P2-2 false "every existing row predates the tab-wide rule" — FIXED.** The
  overstated claim is gone from all three comment sites (`schema.ts:155` JSDoc,
  `drizzle-store.ts:1036`, `core.ts:617`), replaced with the accurate statement:
  DEFAULT 0 is exact for pre-column rows and *conservative* for a v5 DB written by
  this PR's own round-2 build (excess stays **owed**, never misdirected). This is
  now true and honestly scoped.
- **No executable change in the delta.** Every hunk is a comment/JSDoc body or a
  two-line comment deletion. `git show b57b454 --stat` = 44 insertions / 9 deletions,
  all inside comment blocks; no statement, type, DDL string, or conditional is
  modified. Confirmed by reading the full `git diff 4378574..b57b454`.

## (b) Refutation of P2-3 ("existing-but-empty `returns` table skips the ALTER")

**Refutation ACCEPTED — my original finding was wrong.**

`rows` at `apps/api/src/store/drizzle-store.ts:1037` is
`conn.raw.query("PRAGMA table_info(returns)").all()` — the **column list**, one
element per column, never a row count. The gate `rows.length > 0 && !names.has("spreads_across_invoices")` (line 1049) therefore means "table exists and lacks the
column"; a table that exists with zero data rows still returns its column descriptors.

Empirically verified with `bun:sqlite` (bun 1.4.2):

- `CREATE TABLE returns(id TEXT)` (zero rows) → `PRAGMA table_info(returns)` returns
  `[{cid:0,name:"id",...}]` — `length > 0`, so the ALTER runs.
- Missing table → `[]` — the only case that skips. There, `SCHEMA_DDL`
  (`schema.ts:438`) creates `returns` **with** `spreads_across_invoices`, so the
  column exists regardless.

The same `rows.length > 0` idiom already guards `cash_paid_out`, `debt_offset` and
`debt_applied` directly above (lines 1039/1042/1057); the new ALTER is consistent
with the established pattern. The migration test at `drizzle-store.test.ts:465`
additionally pins the ALTER firing on a v5-shaped DB.

## (c) `git diff 911ad509..b57b454` — re-scan of the test additions

Examined: `router.test.ts` (+102), `drizzle-store.test.ts` (+79), `invoice-returns.test.tsx` (+71), `return-calculations.test.ts` (+19), `supplier-return-panel.test.tsx` (+5), `tests/e2e/returns.spec.ts` (+69).

- **Directions are correct, not inverted.**
  - `supplier-return-panel.test.tsx:320` now asserts `toContain("الدين الذي علينا
    للمورّد")` **and** `not.toContain("لنا عند المورّد")` — with `balance > 0`
    (shop owes supplier) that is the right money direction.
  - `return-calculations.test.ts:376` replaces the vacuous `INV-0009`/`INV-0010`
    pair with `INV-9999`/`INV-10000`, the only pair that separates numeric from
    lexical ordering; the comment "a lexical compare would put INV-10000 before
    INV-9999" is accurate.
  - The four new `router.test.ts` boundaries (explicit+shrink, defaulted+shrink,
    explicit+own-settled, all-cash) each assert the specific invoice that must move
    and the one that must not; no test asserts the pre-fix spill direction.
- **No fixture hides a regression.** The v5 migration fixture
  (`drizzle-store.test.ts:465`) hand-builds the v5 column set (debt_applied present,
  spreads absent), asserts the ALTER landed via `PRAGMA table_info`, asserts a legacy
  row reads `false`, an old-build insert reads `false`, a row this build writes keeps
  `true`, and re-runs `setup()` for idempotency. The spread assertion is not
  satisfiable by a constant `false`, so it bites.
- **Duplication:** none material. The new explicit-shrink/defaulted-shrink tests are
  distinct from the pre-existing oldest-first test (no payment-in-between case existed).
- **Watch item (P3):** seven pre-existing `invoice-returns.test.tsx` cases gained an
  `await flushAsync()` before typing, needed because the untouched form now waits on
  the party-tab read. These waits are a timing accommodation, not an assertion
  weakening; the new `splitUnknown` test still pins the blocked path (disabled button
  **and** handler guard **and** on-screen reason). No hidden regression found.

## (d) Spec closure — the five Greptile findings at `911ad509`

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Explicit returns spill across invoices | **Closed** | `router.ts` records `spreadsAcrossInvoices` (true only for the derived default) and gates the spill on `left > 0 && existing.spreadsAcrossInvoices`; `router.test.ts` "keeps an EXPLICIT return on its own invoice after a payment shrinks that debt" |
| 2 | Next return loses its preview | **Closed** | `displayedSettlement` derived in-render replaces the stale mirror effect; unit test + e2e `returns.spec.ts` "the derived settlement method and its preview come back for the next return after a save" |
| 3 | Unknown defaults can be saved | **Closed** | `splitUnknown` blocks the untouched submit in the handler and disables the button, with a visible `returns-split-unknown` reason; test "blocks an untouched save while the split is unknown…" asserts `lastCreateInput === null` after a raw form submit |
| 4 | Supplier hint reverses the debt | **Closed** | `i18n.ts:927` uses `الدين الذي علينا للمورّد`; test pins the direction and rejects the old wording |
| 5 | Ordering test misses string sorting | **Closed** | `INV-9999`/`INV-10000` pair in `return-calculations.test.ts` |

## Verification run

- `bun:sqlite` PRAGMA probe — passed (see (b)).
- `apps/api: bun test src/store/drizzle-store.test.ts src/rpc/router.test.ts` — **338 pass / 0 fail**.
- `apps/web: bun test src/pages/invoice-returns.test.tsx src/components/parties/supplier-return-panel.test.tsx` — **78 pass / 0 fail**.

Full-suite/typecheck/lint numbers in the lane's `round3/README.md` were not re-run here.

## Residual risks (all P3)

- `spreadsAcrossInvoices` is a **required** field on `returnSchema`, a wire-contract
  change; safe only because web and api ship together in this repo (acknowledged in
  the lane's README).
- A v5 DB from the unshipped round-2 build silently degrades a defaulted promise to
  own-invoice-only (excess stays owed). Intentional, documented, and non-misdirecting.
- The `await flushAsync()` inserts slightly loosen the timing of seven legacy form
  tests.
