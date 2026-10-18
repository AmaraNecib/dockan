# Pre-push review — `788503b` (parent `79d8c53`, PR #263, issue #254 round 3)

Reviewer: independent review subagent. Review-only: no source file was modified.
Diff under review: `git diff 79d8c53..HEAD` (16 files: 4 source/test files + docs/evidence).
Context read: `git diff d843566..HEAD` (PR-wide).

Spec sources:
- `D:/projects/mani-project/.scratch/sessions/crew/briefs/fix-254-money-display-round2.md` (findings 1, 2, 3)
- `.scratch/implementation/254-design.md` (design note, rounds 1–3)
- `git log -1 --format=%B` at HEAD (evidence block)

Command run by me (not taken from the commit body):
`cd apps/web && bun test src/components/ui/amount.test.tsx src/pages/items.test.tsx`
→ **66 pass, 0 fail, 179 expect() calls**. e2e was **not** re-executed by me.

---

## Standards axis

The change follows the repo's own conventions: the money primitive stays the single renderer
(`amount.tsx` docstring updated to carry the new invariant), the guard test is a source scan with a
documented scope, and the new i18n key carries an inline comment explaining why the header needed its
own key (`i18n.ts:263-265`). No baseline smell rises above a judgement call:

- **Primitive Obsession / Speculative Generality** — none introduced. The wrapper adds no prop, no
  branch, no API surface; `Money`'s signature is unchanged.
- **Duplicated Code** — none. The `<Trans> + <Amount>` route is the pre-existing one from
  `activity.tsx`/`invoice.tsx`, not a second mechanism.
- Minor: `Amount`'s `className` prop now lands on the two inner runs while the *outermost* element is
  the wrapper — the prop name reads like an element class but is two classes. Only `stock.tsx:144`
  passes one (a colour), so nothing breaks today. Judgement call, see Note 3.

## Spec axis

- **Finding 3 (wrap) — closed.** `Money` now returns one `<span dir="rtl" className="whitespace-nowrap">`
  (`amount.tsx:57`) holding both runs; figures keep `dir="ltr"`, currency keeps no `dir`. The prompt's
  cited site really is a `flex flex-wrap` row (`supplier-opening-balance.tsx:791-793`), so pre-fix the
  runs were two flex *items*, and post-fix the row sees one item (asserted by the new unit test
  `amount.test.tsx:87-104`, incl. `host.firstElementChild === wrapper`).
- **Finding 1 (translated money) — closed, including the round-2 deferral.** `itemsProfitPerUnit`
  becomes `"الربح لكل وحدة: <money/>"` (`i18n.ts:262`), interpolated through
  `<Trans components={{ money: <Amount value={profit} /> }}>` (`items.tsx:565`); the header gets its
  own key (`i18n.ts:265`, used at `items.tsx:852`). Only two consumers of the key existed
  repo-wide (verified by grep: `items.tsx:565`, `items.tsx:852`, plus the literal assertions in
  `items.test.tsx`); nothing is left pointing at the old `{{profit}}` shape, and the old header's
  dangling `:  دج` is gone (asserted at `items.test.tsx:1367-1374`).
- **Finding 2 (currency styling) — refutation verified.** `Amount` passes the caller's class to *both*
  runs (`amountClassName`/`currencyClassName` both get `cn("font-mono tabular-nums", className)`), the
  pinning test "applies the caller's className to the currency" exists and passes, and the diff at HEAD
  does not touch those lines. Correctly refuted.
- **No bypass left (question 3).** Repo-wide, the only non-test `دج` occurrences are the catalog's own
  label keys (`i18n.ts:172,173,221,390,424,425,530,672,933,970` — input labels like `المبلغ (دج)`, not
  money displays) and `currencyDinar` (`i18n.ts:90`, read only by `amount.tsx`). The catalog guard
  returns `[]`. No `.tsx` outside the primitive names the currency.
- **Guard non-vacuity (question 2) — genuine.** `catalogMoneyTemplateOffenders` was refactored to take
  `source`, and the test now proves the detector fires on a fixture with the pre-fix shape
  (`amount.test.tsx:191`) *and* that the real catalog is clean (`:193`). It would fail if the detector
  stopped matching. The tree-scan guard keeps its own non-vacuity test (`files.length > 30`,
  contains `amount.tsx`).
- **No scope creep.** The header rename is required by the fix, the `<Trans>` route is the established
  one, and the e2e additions (env-gated video, geometry helper) are evidence plumbing.

---

## Findings, ranked

### 1. Note (non-blocking) — the wrapper's `dir="rtl"` is now a hard override of the mount context
`amount.tsx:57`. Pre-fix the two runs inherited the ambient direction; they are now always laid out
RTL. I swept every `Money`/`Amount`/`PrintAmount` call site in `apps/web/src` (≈60 mounts) for an
LTR-based parent and found none:
- explicit `dir="ltr"` mounts are only `print-sheet.tsx:53,71` (phone/ref), `receipt-view.tsx:45`
  (invoice number), `return-voucher-view.tsx:38,44` (number/invoice), `returns.tsx:67` (invoice
  number) — none contains a money primitive;
- the printed money cells are `td.print-sheet-money` (`print-sheet.tsx:146,149,181`), which inherit the
  sheet's RTL direction — the cell that carries `cell-ltr` is the *quantity* cell
  (`print-sheet.tsx:142`, `.cell-ltr` at `index.css:672-676`);
- the other flex/grid parents (`receipt-view.tsx:66-70`, `sale.tsx:498`, `invoice.tsx:922-927`) are
  RTL.

So the drawn order does not move today, and `invoice-print-a4.spec.ts:247-255` (currency's right edge
≤ figures' left edge) still holds. The residual risk is forward-looking only: a future amount mounted in
a deliberately LTR container would now draw currency-left, and no test pins LTR-context behaviour.
Non-blocking; the docstring already states the invariant.

### 2. Note (non-blocking) — `whitespace-nowrap` trades a wrap for possible overflow, and the new e2e cannot see the difference
`amount.tsx:57`. Making the pair atomic is the right fix for the finding, but the amount can no longer
break at all, so in a container narrower than the whole amount it overflows (table cells with fixed
widths, `td.print-sheet-money`, narrow grid tracks). The new e2e squeezes the row to `digits + 2px`
(`tests/e2e/supplier-adjustment.spec.ts:574-599`) and asserts only `|Δy| < 4`; it never asserts the
currency is still inside the row's/box's bounds, so a clipped currency would still pass. Non-blocking
test-quality note; the fix direction is right.

### 3. Note (non-blocking) — `Amount.className` is not an outer-element class
`amount.tsx` `Amount()` passes the caller's class to the two runs; the new wrapper takes no caller
class. A future caller passing layout utilities (`truncate`, `flex-1`, `block`, margin) would get them
on the inner runs while the wrapper governs the box. Today the only passing caller is `stock.tsx:144`
(`text-foreground`, a colour), so no impact. Worth a sentence in the prop docstring; not a defect.

### 4. Note (non-blocking) — documented heuristic limits of the two guards
- Call-site guard (`amount.test.tsx:163-181`) scans `apps/web/src/**/*.tsx` only. A money string
  assembled in a `.ts` module would evade it. I verified no `.ts` file outside `i18n.ts` contains the
  currency literal, so it is accurate today.
- Catalog guard (`amount.test.tsx:146-155`) is a single-line regex, so a multi-line or
  template-literal catalog entry with `دج` + `{{` would evade it, and it deliberately permits the
  input-label keys that legitimately embed `(دج)`.

### 5. Verified-correct (no action)
- Both runs stay siblings-of-nothing inside the wrapper; `runs()`-based unit tests still pass, so the
  `data-testid` contract (`money-figures`/`money-currency`) is intact for the geometry helpers.
- `Money`'s sign behaviour, `formatMoney`, and the currency placement are untouched by this commit.
- `tests/e2e/items-categories.spec.ts:39-48` restores the selling price to `350` before saving, so the
  flow's later assertions are unaffected; the video is env-gated (`E2E_VIDEO`), CI records nothing.
- `itemsProfitPerUnitHeader` did not collide with an existing key (repo-wide grep: one definition, one
  use).

---

## Verdict

**Approve for push** (as a commit-only action; I did not push). No blockers, no regressions found in
any of the three prompt questions:

1. Forcing `dir="rtl"` changes no drawn order at any existing call site — no money mount sits in an
   LTR-based container, the print sheet's money cells are RTL by inheritance, and its pinned geometry
   is unaffected. Residual: an LTR container in future would flip (Note 1).
2. No call site, test, or translation consumer is left broken by the `itemsProfitPerUnit` →
   `<money/>` + `itemsProfitPerUnitHeader` change; the catalog guard is non-vacuous (fixture + real
   scan) and now has an empty allow-list.
3. No money display in `apps/web` bypasses the primitive: the only surviving currency literals are
   input labels in the catalog and the primitive's own read of `currencyDinar`.

Findings 1 and 3 are closed with red-first evidence named (`amount.test.tsx:97` `Expected: "rtl",
Received: null`; `items.test.tsx:1362`; `items.test.tsx:1373`); finding 2's refutation is correct and
verified in the code, not taken on trust.

Residual risks: (a) not re-executing Playwright — the e2e green claims (`supplier-adjustment.spec.ts`
narrow row, `invoice-print-a4.spec.ts` geometry, `items-categories.spec.ts`) are the author's; (b) the
LTR-context and overflow notes above are untested by construction.
