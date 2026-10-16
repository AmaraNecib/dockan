# Test audit — issue #96 round 2 — head `7fd7aea`

Auditor: test-audit reviewer. Delta audited: `b7038b5...7fd7aea` (round-2 fix to the invoice-returns
action gate). Files in delta: `apps/web/src/pages/invoice.tsx`, `apps/web/src/lib/i18n.ts`,
`apps/web/src/lib/i18n.test.ts`, `apps/web/src/pages/invoice-returns.test.tsx`,
`tests/e2e/96-returns-supplier-action.spec.ts`, `tests/e2e-selection.map.json`, plus
`.scratch/implementation/96-design.md` and two round-2 screenshots.

**No source or test file was edited by this audit.** The skill's step 5 ("apply fixes") is skipped on
purpose: the assigned task is audit-only ("Do not edit any source file"), and review-only wins over
the skill's fix step. Every "Fix it"-class item below is reported, not applied.

## Test run (evidence)

Command: `cd apps/web && bun test --timeout 20000 src/pages/invoice-returns.test.tsx src/lib/i18n.test.ts`

Result: **70 pass / 0 fail, 809 expect() calls, 2 files, 8.25 s.** Includes all four new round-2 unit
cases and the `i18n.test.ts` key-completeness spec that now enumerates the 5 new keys
(`i18n.test.ts:300-304`). NOT run: the Playwright spec (needs live server + browser), `typecheck`,
`lint`.

## What the new tests pin (verified against the diff, not the prose)

`git diff b7038b5...7fd7aea -- apps/web/src/pages/invoice.tsx`: the base branch was a single
`returns.length === 0 ? <EmptyState action={hasReturnableLine ? <return-action/> : undefined}> : table`
with no kind gate, no `savedReturn` gate and no read-failure gate. So all four new unit cases fail on
`b7038b5` by construction — they are real pins, not tautologies:

| new case | line | fails on base because |
| --- | --- | --- |
| purchase + supplier → supplier account link | `invoice-returns.test.tsx:324` | base renders the customer-return action and form |
| purchase, no supplier → suppliers list | `:338` | same |
| saved-return stale window | `:347` | base renders the action while `savedReturn` is set |
| history read failed | `:361` | base has no `returnsUnavailable` gate at all |

Assertions are behavioural, not incidental: absence of `returns-empty-action` **and** `returns-form`
(cited `:330-331`, `:341`, `:357-358`, `:366-367`), the presence of the branch-specific hint copy
(`:333`, `:342`, `:370`), and the link target (`:334-335`, `:344`). The stale-window case drives the
**real** save path (`typeInto` + `submitForm`, `:350-352`) rather than poking state, and asserts
`returns-done` is present, so a regression that silently drops the card also fails it.

`isSale` / `supplierAccountId` / `returnsUnavailable` (`invoice.tsx:419,420,425`) all have at least one
executing test on both sides; there is no unexercised new branch.

## The e2e stale-window proof — holds without racing

`tests/e2e/96-returns-supplier-action.spec.ts:123-131` gates the second and later
`returnsForInvoice` reads on a promise the test resolves manually; the first (page-load) read is
allowed through. The window is therefore held open by the harness, not by timing:

- The stale-state assertions (`:151-154`) run while the refetch is still blocked, so they cannot pass
  by catching a lucky moment.
- The final step is the real proof: `release()` then `await expect(getByTestId("returns-row"))`
  (`:161-162`) can only succeed if the earlier reads were genuinely held and then completed — if the
  gate had not held, the state would have advanced past the empty state and `:150`/`:151` would have
  failed first (loud failure, never a false pass).
- The precondition before submit is explicit (`:145-146`: form visible AND `returns-empty-action`
  visible) so a mis-gated run can't start from the wrong state.

Same reasoning for the purchase spec (`:75-76`, `:88-91`): it asserts the dead end is gone and then
follows the offered path to `supplier-balance`, i.e. it proves the replacement path works, not just
that a branch flipped.

## Findings (5)

1. 🟡 **The e2e purchase assertion does not pin the with-supplier hint copy** —
   `tests/e2e/96-returns-supplier-action.spec.ts:73` asserts `toContainText("مرتجعات المشتريات")`,
   a prefix shared verbatim by both `invoiceReturnsPurchaseHint` and
   `invoiceReturnsPurchaseNoPartyHint` (`i18n.ts:564-565`). The with/without-supplier hint branch is
   pinned only by the unit tests (`:333`, `:342`). Low risk — the branch itself is covered — but the
   e2e assertion as written would also pass for the no-party branch.
2. 🟡 **Unpinned combination: purchase invoice whose history read failed** —
   `invoice.tsx:590` evaluates `!isSale` before `returnsUnavailable`, so a purchase invoice always
   shows the supplier action even when the read failed. That precedence is a deliberate-looking
   choice but no test asserts it (the failed-read case at `:361` is SALE-only, the purchase cases at
   `:324`/`:338` have a healthy read). A future reorder of the two branches would ship silently.
   Cheapest close: one case with `kind: "PURCHASE"` + `failReturnsRead = true` asserting the supplier
   action is still offered and `returnsUnavailable` copy is absent.
3. 🟡 **`returnsUnavailable` only fires when there is no cached list** — `invoice.tsx:425` uses
   `isError && data === undefined`. A failed *refetch* with cached data still renders the form against
   the cached cap. No test covers the two-state (`isError` with `data` present) side of the gate, so
   the wording "the cap is never guessed" is broader than what is pinned. Expectation is defensible
   (cached data is a real cap), but it is an untested branch of a new condition.
4. 🟡 **Unit stale-window case never reaches the post-refetch end state** —
   `invoice-returns.test.tsx:347-359` leaves the mocked history read permanently `[]`, so it proves
   only the withheld window; the recovery (`returns-row` visible again, empty state gone) is proven
   only by the Playwright spec (`:162`). Acceptable given the e2e covers it, but the unit file has no
   "refetch lands → action returns" case; if the e2e is skipped (serial mode, `:24`, skips the second
   test when the first fails) that recovery path is unverified for the whole run.
5. 🟡 **Expected copy is read from `i18n.t` on both sides** (`:333`, `:342`, `:370`) — a key that
   rendered as its own name would still satisfy `toContain`. Not vacuous *in this delta* because
   `i18n.test.ts:300-304` enumerates all 5 new keys against the real Arabic resources, but the unit
   assertions alone do not detect a missing key.

No 🔴 or 🟠 finding. Nothing found that would break a shipped path: every new branch is executed by a
test, the value assertions are behavioural, and the e2e window is gated rather than raced.

## Residual risks

- Playwright spec, `typecheck` and `lint` were not executed here (no live server/browser in this
  audit); the e2e reasoning above is a read of the spec, not a run.
- The `href` assertions (`:334-335`, `:344`) depend on the stub `Link` in
  `apps/web/src/tests/router-mock.tsx` emitting `to` + serialised `params`; I did not open that file
  within budget, so the exact href shape is taken from the passing run (the assertions pass, so the
  shape is at least self-consistent with the stub).
- Scope = `b7038b5...7fd7aea`. Pre-existing round-1/round-3 findings in
  `.scratch/reviews/96/*-test-audit.md` were not re-verified.
- `tests/e2e-selection.map.json:144` adds the new spec to the returns bucket — correct place (same
  lane as `returns.spec.ts`), no other bucket needs it.

VERDICT: findings (5)

- 🟡 `tests/e2e/96-returns-supplier-action.spec.ts:73` — e2e purchase assertion uses a hint prefix shared by both purchase hints; with/without-supplier copy pinned only by unit tests.
- 🟡 `apps/web/src/pages/invoice.tsx:590` — `!isSale`/`returnsUnavailable` precedence (purchase + failed read) is an untested combination.
- 🟡 `apps/web/src/pages/invoice.tsx:425` — `isError && data === undefined`: failed refetch with cached data still renders the form; that side of the gate is untested.
- 🟡 `apps/web/src/pages/invoice-returns.test.tsx:347` — stale-window unit case never reaches the post-refetch end state (recovery pinned only by the serial e2e spec).
- 🟡 `apps/web/src/pages/invoice-returns.test.tsx:333` — expected copy taken from `i18n.t` on both sides; key-absence is caught only by `i18n.test.ts:300-304`.
