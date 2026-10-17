# #256 / PR #269 — TEST-AUDIT lens, delta pass (round 3 follow-up)

reviewed SHA b57b454 (round-2 base 911ad509; previous test-audit 10af27b; test commit under review 4378574)

- **Scope:** only the tests added by `4378574` and whether `b57b454` invalidates them.
- **HEAD check:** `git diff 4378574..b57b454` touches only comments — `apps/api/src/db/schema.ts` (doc comment),
  `apps/api/src/store/drizzle-store.ts` (doc comment above the ALTER), `apps/web/src/pages/invoice.tsx` (two orphan
  comment lines removed), `packages/contracts/src/core.ts` (doc comment) and `.scratch/reviews/256/round3/README.md`.
  No executable line changed, so every discrimination conclusion below carries over verbatim to b57b454.
- **Read (production):** `apps/api/src/rpc/router.ts:1599-1670` (create: `spreadsAcrossInvoices` set only on the derived
  default), `:1736-1805` (accept: `left > 0` → own invoice → `left > 0 && existing.spreadsAcrossInvoices` → tab),
  `apps/api/src/store/drizzle-store.ts:1038-1046` (ALTER gate), `apps/web/src/lib/i18n.ts:927`,
  `apps/web/src/components/parties/supplier-return-panel.tsx:268`.
- **Not re-run by this lens:** the suite and the ablations (no-edit lens; the parent reported the ALTER-dropped run and the
  gates). Discrimination below is derived by reading each assertion against the production branch it must fail on, plus the
  pre-existing fixtures it would collide with.

## Verdict

**Closed.** M1, M2 and M3 are all genuinely pinned; one of the two M3 tests is weak (structurally unable to fail) but no
added test is vacuous in the "asserts nothing" sense and no added test asserts a wrong behaviour. **No new must-fix.**

## M1 — CLOSED — `drizzle-store.test.ts:465-533` ("migrates a v5 returns table…")

- Pins the ALTER: `expect(cols.map((c) => c.name)).toContain("spreads_across_invoices")` on `PRAGMA table_info(returns)`
  after `setup()`. Drop the `ALTER TABLE` at `drizzle-store.ts:1046` and this line goes red before any store call runs —
  the failure is at the schema, not a downstream symptom (the parent reproduced exactly this).
- Pins the **value**, not just the presence: `getReturnDetail("legacy-ret")?.spreadsAcrossInvoices === false`
  (`:490`) would fail if `DEFAULT 0` became `DEFAULT 1`, which is the silent re-introduction of the round-2 spill.
- Not vacuous: `?.` + `toBe(false)` fails on `undefined`, so a broken `getReturnDetail` cannot pass it.
- Not a constant: the `insertReturn({ spreadsAcrossInvoices: true })` round-trip (`:500-517`) makes a
  hardcoded-`false` mapping fail, so the mapping (not the DDL) is pinned too.
- Idempotency is pinned (`:520-523`), covering the re-`setup()` path the gate could double-ALTER.
- The hand-rolled v5 DDL (`:478-484`) is the same pattern the neighbouring `:2053` pre-settlement migration test uses;
  drift risk exists but is precedent, not a regression.

## M2 — CLOSED — `supplier-return-panel.test.tsx:322-329`

- The added assertions are **literals**, not `i18n.t(key)` round-trips (the failure mode the audit's H3 named):
  `toContain("يُخصم من الدين")`, `toContain("الدين الذي علينا للمورّد")`, `not.toContain("لنا عند المورّد")`.
- Reverting `i18n.ts:927` to the pre-fix wording (`…الدين الذي لنا عند المورّد…`) breaks both new assertions, while the
  old single assertion (`toContain("يُخصم من الدين")`) stayed green — so the direction, which is the whole content of the
  fix, is now the thing under test.
- The negative assertion is scoped to the note element (`defaultNote()` reads only
  `[data-testid="supplier-return-cash-default"]`), so the unrelated `supplierBalanceCredit: "رصيد لنا عند المورّد"`
  (`i18n.ts:884`) cannot make it fail spuriously, and `toContain` on a real rendered literal cannot pass for a raw key.

## M3 — CLOSED — `router.test.ts:3778-3820`

- `:3778` (explicit return, own invoice settled before acceptance) is the discriminating one: `own = min(left, 0) = 0`,
  `left = 300`, `invoiceOther` open at 400. Reverting the guard to `if (left > 0)` (`router.ts:1779`) spills all 300 onto
  the older `invoiceOther`, so `settledOther.remainingAmount` 400 and `returnCreditAmount` 0 both go red (same shape and
  same discrimination as the F1 test at `:3719`). Inverting the flag (`!spreadsAcrossInvoices`) also reds it.
- `:3801` (accepted all-cash explicit return, `debtOffset 0`) documents the `left === 0` boundary. Its real content is the
  create-side pin (`created.debtOffset === 0`) plus "acceptance relieves nothing"; it cannot fail on the flag itself
  (see Note N1).
- The audit's other two boundaries are already covered and not lost: `own === 0` on a **defaulted** return spreading the
  whole promise onto the tab is `:3657-3696` ("allocates the default … OLDEST first", own invoice paid at creation, 300 =
  200 + 100) — that test also kills any "spread only if `own > 0`" mutation; and the interior point
  (`0 < own < debtOffset`) is `:3719` + `:3753`.

## New must-fix

None. No added assertion is wrong, none is vacuous in the "would pass on an empty implementation" sense, and no added test
overfits a helper such that it stops constraining behaviour (the store test's DDL duplication is precedent, the i18n pin is
a literal, the router tests reuse `makeReturnItem` and assert post-state through the public API).

## Nice-to-have (not blocking)

- **N1 — `router.test.ts:3801-3820` is low-discrimination.** With `left = 0` the allocation block is a no-op under every
  reachable mutation of the guard (`own = min(0, ·) = 0`, `take = min(0, ·) = 0`, `if (left <= 0) break`), including
  "flag always true". Keep it if the create-side pin is wanted, but the boundary it names is already structurally safe;
  the audit's M3 case 3 — **defaulted return, `left > 0`, no other open invoice** (`left` never fully applied, must still
  accept with `debtApplied === own`) — remains untested and *is* falsifiable.
- **N2 — `supplier-return-panel.test.tsx:327` couples to exact wording.** Any legitimate reword of
  `supplierReturnDefaultDebt` reds the suite even if the direction stays correct; a shorter direction-bearing substring, or
  a comment stating the pin is deliberate, would reduce future churn. Acceptable as-is (literal > key).
- **N3 — `drizzle-store.test.ts:472-533` hand-copies the v5 `invoices`/`returns` DDL.** Fine by precedent (`:2053`), but
  it does not pin the **existing-but-empty** `returns` table variant; the code-review lens showed that is not a bug
  (`rows` is `PRAGMA table_info`), so this is one cheap line if the guarantee is ever wanted explicitly.
- **N4 — no test for a defaulted return whose own invoice is paid *after* creation and whose whole promise then spills
  (`left === debtOffset`).** Covered in effect by `:3657` (own = 0 at creation); a payment-timing variant would pin the
  read-inside-the-transaction ordering more directly.

## Residual risks of this pass

1. I did not re-run the suite or repeat the three ablations (no-edit lens). M1's red state is the parent's, not mine; M2
   and M3 discrimination is argued from the assertions against `router.ts:1779` and `i18n.ts:927` as read.
2. `b57b454`'s comment claim ("v5 has never shipped") is asserted in `.scratch/reviews/256/round3/README.md` with a
   `git merge-base --is-ancestor 7020666 origin/develop` check; that is a code-review/provenance matter, out of this lens,
   and comment-only for the tests.
