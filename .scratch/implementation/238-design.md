# #238 — one blankness predicate, shared by every numeric-draft reader (design)

- Tier: **High-assurance**. Justification: the diff decides whether a *mark-only*
  initial-payment draft books the whole invoice as debt (`resolveInitialPaid`
  mark-only goes from refusal → `undefined`), which is failure mode (2) «a total
  is computed wrongly» and (3) «debt direction is wrong»; and it is the #227
  free-line hole's sibling class on the invoice-total path (mode 2). The tier
  follows the failure mode, not the diff size (`docs/engineering-workflow.md`).
- Base: `origin/develop` @ `2c8d867`. This is the #239 squash-merge (PR for #227),
  so `draftBlank` is present on the base as the brief requires. `git merge-base
  origin/develop HEAD` == `2c8d867` == HEAD.
- Authority: commit only. This lane does **not** push, open a PR, merge or write
  `.agents/wisdom/`.

## Problem

#227 fixed one instance: a mark-only sale override billed the line free because a
raw `.trim()` guard read a stripped-to-empty draft as a chosen value while the
loose reader read it as `0`. The same shape survives at three more sites. A
normalisation that can **empty a non-blank draft** re-opens *every* raw-blank
guard. A bidi mark is Unicode `Cf`, not ES `WhiteSpace`, so `.trim()` does not
drop it; `normalizeArabicIndicDigits` does.

"Blank" is four separate opinions today; three of the four are right only by
accident, through `Number("") === 0`.

## The one invariant

**Blankness is decided once, by the same normalisation the reader uses.**
Unify the *test*; do **not** unify the *fallback* — #146's design doc makes the
per-site fallbacks deliberate (`cleared reads 0, digits read their value,
unreadable keeps the previous`).

## Where `draftBlank` belongs

`normalizeArabicIndicDigits` and `percentageDraftInvalid` live in
`apps/web/src/lib/amount-parse.ts`. `draftBlank` is exported from there, beside
the normaliser it depends on, and imported into `invoice-draft.ts`. That is the
point: a new normalisation added to that file meets the predicate. The private
`draftBlank` in `invoice-draft.ts` is deleted.

## The four sites (predicate unified, fallback preserved)

| site | file | today | after | fallback preserved |
| --- | --- | --- | --- | --- |
| `saleUnitPrice` / `saleOverrideInvalid` | `invoice-draft.ts:199` / `:214` | already via `draftBlank` (private) | same predicate, now imported | blank → default price / invalid |
| `percentageDraftInvalid` | `amount-parse.ts:154` | raw `draft.trim() !== ""` → mark-only is *invalid* | `!draftBlank(draft) && parseWholePercentage(draft) === null` | blank → **not invalid** (the legitimate «not chosen») |
| `resolveInitialPaid` | `invoice-draft.ts:412` | raw `amountDraft.trim() === ""` → falls through to the grouped reader → refusal | `draftBlank(amountDraft) ? undefined : parseGroupedAmount(...)` | blank → `undefined` (unpaid), not a refusal |
| `nextUnitCost` | `invoice-draft.ts:242` | `parseLooseNumber` → `Number("")` → 0 | `if (draftBlank(value)) return 0;` then parse | blank → `0` (unchanged outcome; the *reason* becomes the predicate) |

`resolveInitialPaid`'s existing `paid === 0 → undefined` and over-total refusal
are untouched. `percentageDraftInvalid` remains a validity gate only; the amount
stays the paid value.

## Deliberately left alone

- `parseQuantityDraft` (`invoice-draft.ts`) inlines `normalizeArabicIndicDigits(draft).trim() === ""`,
  which is character-for-character `draftBlank`. It is a *reader*, not a guard,
  and it needs the normalized string for the digits regex, so routing it through
  `draftBlank` would normalise twice for no behavioural gain. Not a fourth
  opinion; equivalent by construction.
- `discountAmountFor` / the sale discount has no blank guard and reads a
  mark-only draft as a zero discount through `nonNegativeOr` — the legitimate
  «no discount», and it cannot bill a wrong number. It has no free-line hole, so
  it is not in the table (#227 recorded this).
- The page-level raw `.trim()` checks (`hasCustomer`, discount, etc.) are
  whitespace-only decisions on non-money drafts; they do not face a mark-stripped
  draft and are out of scope.

### Numeric-draft raw-`.trim()` gates deliberately deferred (review-found)

The shared predicate reaches the sites above. Review round 1 found more numeric
readers that still test blankness on a raw `.trim()`; all are **pre-existing** and
none is newly diverged by this change, so they are filed as follow-ups rather
than widened into this diff (wisdom `2026-10-15-extraction-ordering-guard.md`: a
shared helper's docstring must name the readers it covers and file the gap):

- `resolveOpeningStock` (`apps/web/src/lib/numeric-input.ts:58`) — a mark-only
  opening-stock draft is `{ok:false, reason:"invalid"}` where blank is
  `{ok:true, value:0}`. A safe refusal (no wrong number), different flow.
- `supplier-opening-draft.ts:26` / `supplier-adjust-panel.tsx:77` — opening
  balance and adjustment amount drafts.
- `customer-settle-panel.tsx:95` / `supplier-pay-panel.tsx:88` — the settle
  panels' amount error-message guards.
- `amount-percentage-input.tsx:66` — the over-100% clamp condition; provably
  outcome-neutral for a mark-only draft (`parseLooseNumber` → 0, not > 100).
- `invoice.tsx:502` / `supplier-return-panel.tsx:80` — return-quantity drafts.

`parseQuantityDraft`'s inline `normalizeArabicIndicDigits(draft).trim() === ""`
is character-for-character `draftBlank`; it is a reader that needs the normalised
string for its digits regex, so routing it through the predicate would normalise
twice for no gain. Equivalent by construction, not a fifth opinion.

## Why the mark set is exported

The class closes only if a test drives the *whole* mark set, not one character.
`PASTED_BIDI_MARKS` changes from a private regex to an exported `readonly string[]`
and the strip's regex is built from it, so the test's set and the production set
are one object. Adding a mark to the list automatically covers every site. The
regexes (`PASTED_BIDI_MARK`, `DRAFT_CONTENT`) are derived from the list.

## Public interfaces / dependencies

- `apps/web/src/lib/amount-parse.ts`: new export `PASTED_BIDI_MARKS: readonly string[]`
  (still no runtime consumer outside the module); new export
  `draftBlank(draft: string): boolean`.
- `apps/web/src/lib/invoice-draft.ts`: imports `draftBlank`; no signature change
  to `saleUnitPrice`, `saleOverrideInvalid`, `nextUnitCost`, `resolveInitialPaid`.
- No new dependency, no API/contract change.

## Planned tests

- `apps/web/src/lib/draft-blankness.test.ts` (new, the "one table"):
  1. **All sites, one table.** For a mark-only draft, the empty draft and a real
     digit draft, assert every site's verdict; mark-only must equal empty at every
     site (the class invariant). Sites: `saleOverrideInvalid`, `saleUnitPrice`,
     `percentageDraftInvalid`, `resolveInitialPaid`, `nextUnitCost`, `draftBlank`.
  2. **Drive the mark set.** Loop `PASTED_BIDI_MARKS`, including the
     whitespace-wrapped paste shape, and assert mark-only == empty at every site.
  3. **Interior-mark refusal stays a refusal.** `1\u200f2` is *not* blank, is
     refused by every guard, and `nextUnitCost` keeps the previous value.
- `apps/web/src/lib/amount-parse.test.ts`: the existing `#227` pin
  `percentageDraftInvalid(RLM) === true` becomes the #238 pin `false`.
- `apps/web/src/lib/invoice-draft.test.ts`: the existing `#227` pins
  `resolveInitialPaid(1000, RLM, "")` / `(1000, " \u200f ", "")` become
  `{ok:true, paid:undefined}`; the `nextUnitCost` pins are unchanged.
- `tests/e2e/sale-checkout.spec.ts`: one added test — a mark-only paid draft
  (amount and percentage) saves the invoice instead of surfacing «invalid
  payment». The unit table is the class gate; this is the user-facing flow.
- No full suite: the brief restricts e2e to the single invoice/sale commit spec.

## Review round 1 (independent lenses at `7190e73`)

Seven sub-agents ran (debate critic + defender, test-audit edge/coverage/quality,
code-review standards + spec). Outcomes:

- **Standards blocker — over-claimed docstring.** The `draftBlank` docstring said
  "every blankness guard"; scoped it to the named sites and listed the deferred
  gates (above).
- **`saleDebt` diverged from `resolveInitialPaid`.** The sale screen's pre-commit
  preview is the same decision as the commit resolution; after the `resolveInitialPaid`
  change the preview still refused a mark-only draft, a divergence *this change
  introduced*. Fixed: `saleDebt` now asks `draftBlank`, pinned in `sale.test.tsx`.
- **Regex-class fragility.** `new RegExp(`[${PASTED_BIDI_MARKS.join("")}]`)` would
  silently corrupt the class if a future mark were a metacharacter. Each member
  is now escaped before interpolation.
- **Test strengthening.** Added a discriminating negative to the
  `percentageDraftInvalid` row, drove the interior-refusal and edge-with-digits
  cases over the whole mark set (plus `saleUnitPrice`), and added mixed-mark
  combinations.
- **`nextUnitCost` is behaviour-preserving by construction**; no black-box test
  can fail on its explicit branch. The mutation/ablation below states that.

## Implementation risks

- **Behaviour drift in the payment path.** Mark-only now means «nothing paid
  now» (full debt) instead of a refusal. That is the brief's intended outcome and
  is pinned; the design/PR must state it, because it changes who owes money.
- **Site 4 is behaviour-preserving by construction.** A mark-only and an empty
  `nextUnitCost` draft both already returned `0` via `Number("")`. A black-box
  test cannot discriminate the new explicit branch from the old implicit one; the
  change is a *reason* fix. The mutation proof in
  `.scratch/reviews/238/<sha>-test-audit.md` records that reverting the branch
  leaves the suite green (the honest ablation), while reverting the two real
  behaviour fixes reddens the class test.
- **A blanked-everything predicate.** Pinning «real digit ≠ blank» at every site
  stops `draftBlank` from over-matching.
- **Export shape churn.** Changing `PASTED_BIDI_MARKS` from regex to array is
  module-private before this change (no external consumer), so no caller moves.

## Deliberately out of scope

- No display change; the mark stays in React state, only the predicate ignores it.
- No repo-wide de-duplication of the strict readers (#227 round 2 already
  recorded that as a separate refactor).
