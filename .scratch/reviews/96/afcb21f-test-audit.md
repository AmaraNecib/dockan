# Test audit — issue #96 (empty states), round 3 — head `afcb21f`

Auditor: test-audit reviewer. Delta audited: `5a05144..afcb21f` (UI refactor: `EmptyState` gains
`card`, 12 call sites; items failed-read copy/action change; i18n keys; test updates; evidence/
decisions files). Prior evidence read: `.scratch/reviews/96/9c856bb-test-audit.md` (round 1),
`.scratch/reviews/96/5a05144-test-audit.md` (round 2), `decisions.md`.
No source or test file was edited by this audit.

## Test run (evidence, current HEAD, working tree clean at `afcb21f`)

Command: `cd apps/web && bun test --timeout 20000 <files>` (two concurrent batches of specs whose
pages were touched).

| batch | files | result |
| --- | --- | --- |
| core (items, i18n, invoices, invoice, purchase, activity-empty, history-empty, categories) | 8 | **137 pass / 0 fail**, 1033 expect() |
| refactored pages (expenses, party-detail, returns, reports, diagnostics, stock) | 6 | **126 pass / 0 fail**, 526 expect() |

Aggregate **263 pass / 0 fail, 14/14 files**. This includes `items.test.tsx` (the changed test) and
`i18n.test.ts` (the key-completeness spec that now enumerates the 3 new keys).
NOT run here: Playwright `tests/e2e/01-empty-states.spec.ts` (needs a live server + browser) and
`bun run typecheck` / `lint` — round-2 residual, unchanged.

## Verification asked for

1. **No new blocker / no unverified shipped-path branch — confirmed.**
   The only new production branches in the delta are:
   - `empty-state.tsx:36-41` `card && "rounded border border-border bg-card"`. Both paths execute in
     the suite (true: 12 call sites; false: `pmt-empty`, `returns-empty`, `expense-category-empty`,
     purchase/parties/sale/dashboard/debts). The *rendered class output* is asserted nowhere — see
     `notes` below.
   - `items.tsx:798-800` the `titleKey`/`hintKey`/`actionKey` ternaries. All three outcomes are
     pinned by tests: actionable (`items.test.tsx:402-412`), no-category (`:419-429`), and
     read-failed (`:435-450`). Nothing else in the delta is a new path — the 12 call sites only swap
     `className="… rounded border border-border bg-card"` for `card` (byte-equivalent output:
     `rounded border border-border bg-card`), and every `testId` is unchanged (diff reviewed
     call-site by call-site; `pmt-empty`, `returns-empty`, `expense-category-empty`,
     `purchase-open-picker`, `parties-empty-new`, `sale-open-picker` and the dashboard/recents EmptyState
     are untouched).
2. **Items failed-read state is correctly tested at the new copy/action — confirmed.**
   `items.tsx:793-800` now selects `itemsEmptyCategoriesUnavailable{,_Hint,_Action}` when
   `categories.isError`, and offers the `/categories` link in that state. `items.test.tsx:435-450`
   asserts, after waiting for the rejected read to settle, all three new strings
   (`:443`,`:444`,`:447`) **and** the link target (`:448` `href.split("?")[0] === "/categories"`).
   The old behaviour would fail this test (`el()` throws when the action is absent), so it is a real
   pin, not a tautology. Round-2 **N1 is closed**, and `i18n.test.ts:311-313` adds the 3 keys to the
   completeness list so a missing key cannot make `toContain(i18n.t(key))` pass vacuously.
3. **`card` refactor kept every testid and every test green — confirmed.**
   No `data-testid` changed in any of the 12 call sites; all 14 specs touching those pages pass
   (263/0).

## Fixed (round-2 findings closed by this delta)

| round-2 item | status | evidence |
| --- | --- | --- |
| N1 🟠 items failed-read showed actionable copy with no action/no reason | **FIXED** | `items.tsx:796-813` (own error copy + honest `/categories` action); `items.test.tsx:443-448` |
| Duplicated surface class across 12 call sites | **FIXED** | `empty-state.tsx:36-41` `card` prop; 12 call sites now pass `card`; no `EmptyState` call site still carries the literal class string (`grep -rn "rounded border border-border bg-card" apps/web/src` → only the component + non-EmptyState divs/forms) |
| C3 i18n key completeness for the new strings | **FIXED for the 3 new keys** | `i18n.test.ts:311-313`, `i18n.ts:190-192` |
| Q3 `page-harness.tsx` overclaiming adoption | **FIXED** | `tests/page-harness.tsx:10-14` now says the older specs keep private helpers until touched |

## Open findings

**No new blocker and no new open finding introduced by this delta.** Everything below is a
round-1/round-2 item that this delta did not touch (re-verified against the current tree), plus two
notes.

- 🟠 **E2 (round 2), still open** — `party-detail.tsx:443-444`: while `customersGet` is pending and
  the invoice list is settled-empty, the unpaid-only title is shown. This delta only changed the
  three `className`→`card` sites in that file; the copy logic is byte-identical (`git diff
  5a05144..afcb21f -- apps/web/src/pages/party-detail.tsx`). Risk unchanged, not compounded.
- 🟡 **N2 (round 2), now documented rather than removed** — `items.tsx:798,807`: during the
  pending/retry window `categoriesUnavailable === false`, so the add button (not the `/categories`
  link) renders. `decisions.md:74-77` now records this as a deliberate trade-off ("gating on
  `!isPending` would instead flash a control-less state"), and the new test comment at
  `items.test.tsx:439` acknowledges it. Residual risk accepted by design: a fast click on a slow /
  retrying category read can open the add form with an empty category select. No test pins the
  window.
- 🟡 **N3 (round 2)** — `items.test.tsx:440-442` still relies on the harness's `retry: false`
  QueryClient (2.4 s `waitFor` budget vs react-query's default retry backoff). Flake risk only.
- 🟡 **C4 / E9 / C5 / C6 / E5 / E6 / E7 / E8 / Q3-adoption / Q4 / Q9** — unchanged from round 2;
  `tests/e2e/01-empty-states.spec.ts`, `components/ui/empty-state.tsx` component spec, shared
  `expectNoAction` helper, absence-of-wrong-hint assertions, expenses combination, invoices paging
  reset, items transition, reset-e2e ordering, remaining private `mountPage` clones.

### Notes (not blockers)

1. 🟡 **`card` output is not asserted anywhere.** The delta's whole visual change is one class
   string per call site, and no test asserts class names, so a typo in
   `empty-state.tsx:39` would ship silently (round-1 E9, now with 12× the surface). Also worth
   confirming the `screenshots/{before,after}` set in `.scratch/reviews/96/` was produced at
   `9c856bb`, i.e. **before** this refactor — this audit could not verify that (screenshots are
   binary evidence; harness not re-run here). Cheapest close: `components/ui/empty-state.test.tsx`
   asserting `card` adds the three surface classes and `className` still merges.
2. 🟡 **New copy is not asserted absent of the old copy.** `items.test.tsx:443-448` is
   presence-only (acceptable: the previous copy and the new copy are disjoint strings, so a
   regression to `itemsEmptyHint` fails `:443`). The stricter negative form (`not.toContain`) is
   round-2 C6 and still open for items/invoices/expenses.

## Residual risks

- Playwright spec, `typecheck`, `lint` not re-run in this audit.
- Scope = `5a05144..afcb21f` plus re-verification of the round-1/round-2 findings against the
  current tree. Files outside the #96 change set were not re-audited.
- The three `.scratch/reviews/96/*` evidence files and `decisions.md` are committed into the lane
  branch; consistent with rounds 1-2, noted only for repo-hygiene awareness, not flagged.

**Verdict: delta is safe to proceed.** No blocked path, the items failed-read branch is honestly
tested, the refactor is behaviour-preserving and green (263 pass / 0 fail over 14 changed-page
specs); the only uncompensated gap is the visual `card` output, which is assertion-free by design
of the pre-existing suite.
