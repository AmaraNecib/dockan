# #227 — accept a pasted Arabic-Indic number: drop edge bidi marks (design)

- Tier: **High-assurance**. Justification: the diff sits on the invoice-total
  computation path (a sale line's price override feeds the total), so it can
  violate failure mode (2) «a total is computed wrongly» — round 1 of this lane
  *did* move a billed amount (a mark-only override went from refused to a free
  line), and the same class is what the final round closed. Per the workflow the
  tier follows the failure mode, not the diff size. The brief recorded Standard;
  the failure-mode read makes High-assurance the defensible tier, and the
  High-assurance gates ran: **Debate**, test-audit and code-review.
- Base: `origin/develop` @ `850d1f7`. The brief's stack base
  (`origin/fix-210-arabic-indic-money` @ `afe15fe`) was **merged into `develop`
  while this lane ran** (PR #229/#210), and `develop` has since also merged
  #225 (`nextUnitCost` + the remaining ASCII-only readers) and #226. The six lane
  commits were rebased onto the current `origin/develop`; merge-base with the old
  base is `a52084d1`.
  Overlap analysis: `git diff origin/develop...HEAD` touches only the six #227
  files below. No #229-owned file is re-touched, and `develop` contains neither
  the mark strip nor `draftBlank`, so nothing from the merged #210/#229 is
  re-implemented. #225's `nextUnitCost` change is adapted to, not duplicated (see
  «Where the strip lives»).
- Authority: commit only. This lane does **not** push and does **not** merge.

## Problem

`normalizeArabicIndicDigits` maps digits only, and every strict reader `trim()`s
(`trim` drops ECMAScript `WhiteSpace`; the bidi marks are `Cf` format characters,
and `Cf` is not `WhiteSpace`, so `trim` cannot drop them) but does not strip
Unicode bidi formatting marks. Copying Arabic-Indic digits out of RTL text
carries a Right-to-Left Mark (U+200F) or Left-to-Right Mark (U+200E) at the edge
of the run, so:

- `parseWholeAmount("\u200f٥")` → `null` (expected 5)
- `parseWholePercentage("\u200f١٠٠")` → `null` (expected 100)

Same class #210 set out to remove — «refuses a number the owner can read» —
reached by paste instead of by keyboard, which is the more common path for this
user.

## Where the strip lives

`normalizeArabicIndicDigits` in `apps/web/src/lib/amount-parse.ts` is the one
normalisation step every reader already shares (established in #198, kept by
#210). Every affected reader funnels through it:

| reader | file |
| --- | --- |
| `normalizeArabicIndicDigits` | `lib/amount-parse.ts` |
| `parseWholeAmount` | `lib/amount-parse.ts` |
| `parseWholePercentage` | `lib/amount-parse.ts` |
| `parseLooseNumber` | `lib/amount-parse.ts` |
| `parseGroupedAmount` (and `STRIP_GROUPING`) | `lib/amount-parse.ts` |
| `parseQuantityDraft` | `lib/invoice-draft.ts` |
| `nextUnitCost` | `lib/invoice-draft.ts` (routed by #225) |
| `parseWholeNumber` / `parseSignedWholeNumber` | `lib/numeric-input.ts` (routed by #225) |

Adding the strip there and nowhere else means the paste fix cannot be half
applied: every reader that normalises is covered, and #225 routed the previously
ASCII-only readers (`nextUnitCost`, `numeric-input.ts`, the quick-add fields)
through the same normaliser before this lane landed, so they inherit the strip.
The function keeps its exported name because the brief names it, and only one
production module (`lib/invoice-draft.ts`) imports the function itself (~15
modules import the module). The doc comment now states the widened contract where
the name under-describes it. A rename (`normalizeMoneyDraft`) was considered and
rejected: it would churn the reader modules #225 edits for no behavioural gain.

## Which marks, and where they are dropped

Drop the zero-width directional marks a paste carries at the **edge** of a draft:

- U+061C ARABIC LETTER MARK (ALM)
- U+200E LEFT-TO-RIGHT MARK (LRM)
- U+200F RIGHT-TO-LEFT MARK (RLM)
- U+202A..U+202C (LRE, RLE, PDF) — embeddings and their terminator
- U+2066..U+2069 (LRI, RLI, FSI, PDI) — isolates

The brief named at least ALM/LRM/RLM; the embeddings, PDF and isolates are the
same kind of zero-width directional character, produced by bidi-aware editors
(Word/Excel/PDF copy). At the edge all ten are number-preserving.

**Only edge occurrences are dropped.** A mark *inside* a draft can split a digit
run and let the RTL page reorder it. Measured in Chromium with `dir="rtl"` (the
app is RTL and the money inputs carry no `dir`):

| draft | rendered digit order | logical order |
| --- | --- | --- |
| `\u200f123` (edge) | `123` | `123` |
| `123\u200f` (edge) | `123` | `123` |
| `1\u200f2` (interior) | `21` | `12` |
| `1,\u200f000` (interior) | `000,1` | `1,000` |
| `-\u200f5` (interior) | `5-` | `-5` |

So dropping an interior mark would read a number the owner never saw — the exact
failure this ticket exists to remove. An interior mark is therefore left in
place, and the strict readers refuse the draft: a safe refusal, never a different
number. (This is what the final review round surfaced; the earlier draft stripped
every occurrence and pinned `1\u200f2` → 12, which is wrong in the RTL page.)

**Excluded entirely: the directional overrides U+202D (LRO) and U+202E (RLO).**
They render a run in *forced* order, so a digit run inside one is displayed
reversed (`123` shows as `321`) while the logical characters a paste carries stay
`123`; dropping the override would read a different number. Edge or interior,
they are refused, not removed.

**No legitimate money draft contains any of these marks.** A money draft is
digits (one of three scripts), an optional `-`, grouping separators (`,`,
whitespace, U+066C, U+00A0) and — on the loose reader only — the `e`/`x`/`.` of
`Number()`'s grammar. Every one of those is a *visible* character; each mark
renders as nothing and only exists to order a run of text. At the edge of a
draft it cannot be typed as part of the number, so dropping it can only turn a
refusal into the read the owner intended. Stripping at the edge is silent, with
no warning, on that argument.

Deliberately **not** dropped:

- Interior ALM/LRM/RLM/LRI/RLI/FSI/PDI and the LRE/RLE/PDF embeddings — they can
  reorder a digit run (see the table). Refused, not removed.
- U+202D LRO and U+202E RLO — forced display order. Refused, not removed.
- U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER and U+FEFF (ZWNBSP/BOM): invisible
  format characters, but not `Bidi_Control`. ZWSP/WJ still fail the strict
  readers — a safe refusal. U+FEFF survives the strip but is ECMAScript
  `WhiteSpace`, so `String.prototype.trim()` already dropped it before #227; that
  read-through is pre-existing and pinned.
- U+00A0 NBSP and U+066C: legitimate grouping separators. U+066B (Arabic decimal
  separator) is a *visible* numeric separator, not a bidi mark; deleting it would
  turn `٥٫٥` into `55` — no reader accepts it today, but that is a refusal, not a
  licence to delete it.

## Interfaces / dependencies

No new export, no signature change, no dependency. `normalizeArabicIndicDigits`
gains a private `stripEdgeBidiMarks` helper and stops being a bare pair of digit
maps; `lib/invoice-draft.ts` gains the private `draftBlank` predicate and uses it
at the two override sites (`saleUnitPrice`, `saleOverrideInvalid`), so a
mark-only draft is «nothing chosen» in both.

## Planned tests

1. `apps/web/src/lib/amount-parse.test.ts` — a new `#227` describe:
   - `normalizeArabicIndicDigits` drops each of the ten edge marks (a loop over a
     named table, so a typo'd range cannot pass) and leaves a mark-free draft
     byte-identical (ASCII identity, and the legitimate `1٬000` unchanged).
   - both boundaries: non-`Bidi_Control` invisibles (U+200B ZWSP, U+2060 word
     joiner, U+FEFF BOM) and the LRO/RLO overrides U+202D/U+202E are left
     untouched, so a future widening fails a pin. U+FEFF is pinned as *reading
     through* (`parseWholeAmount("\ufeff5")` = 5) because `trim()`, not this
     strip, drops it.
   - each reader: `parseWholeAmount`, `parseWholePercentage`,
     `parseGroupedAmount`, `parseLooseNumber`.
   - the ASCII-identity case: `parseWholeAmount("\u200f123")` = `123` and plain
     `123` unchanged.
   - paste-shaped inputs, built from `"\uXXXX"` escapes (never an invisible
     literal): leading and trailing marks read; interior marks refuse
     (`1\u200f2` → null, `1,\u200f000` → null, `-\u200f5` → null), which pins the
     RTL display-order rule.
   - negative controls: a mark-only draft still refuses; a marked decimal and a
     marked sign still fail on the strict readers.
2. `apps/web/src/lib/invoice-draft.test.ts` — `parseQuantityDraft` with a pasted
   draft, the sale money path behind it (`saleUnitPrice` AMOUNT/PERCENTAGE,
   `saleOverrideInvalid`, `discountAmountFor`, `resolveInitialPaid`), the
   mark-only override refused + default-priced (the round-1 regression), the
   pre-existing refusals kept visible, and `nextUnitCost` pinned at its #225
   behaviour (a marked/Arabic-Indic value now reads; an edge mark blanks to the
   cleared-field zero; an interior mark keeps the previous cost).
3. `tests/e2e/sale-checkout.spec.ts` — a paste-shaped end-to-end pin: the sale
   quantity, price override and discount are filled with RLM-prefixed
   Arabic-Indic text, the field is asserted to still *hold* the mark (so the pin
   cannot pass by pre-normalising), the totals are asserted, and the invoice
   saves.

## Implementation risks

- **Reading a different number than the page shows.** Bounded by the edge-only
  rule and the LRO/RLO exclusion; the interior refusals and the override
  refusals are pinned. The RTL rendering claim was verified in Chromium, not
  reasoned about (`2026-10-01-rtl-dates-bidi-and-align.md`).
- **A normalisation that empties a non-empty draft.** Dropping an edge mark turns
  `"\u200f"` into `""`, and two guards in `lib/invoice-draft.ts` tested blankness
  on the raw `.trim()`. Left alone, a mark-only sale override would have parsed to
  `0` and billed the line free — the hole `saleOverrideInvalid` exists to close.
  Both now share a `draftBlank` predicate that blanks through the same normalizer;
  the pins assert the mark-only override is refused and prices at the default.
- **"Blank" is not yet one concept.** The remaining raw-`.trim()` guards were
  audited: each either refuses a mark-only draft (`percentageDraftInvalid`,
  `resolveInitialPaid`, `parseReturnQuantities`, `parseCashBackDraft`, `saleDebt`)
  or reads it as the empty value (`discountAmountFor` / the sale discount guard,
  where a zero discount is legitimate and cannot bill a wrong number). The
  refusals that face a *visually empty* field — a mark-only initial-payment draft
  surfaces «invalid payment», a mark-only percentage draft is reported invalid —
  are pre-existing and unchanged. **Deferred, not dismissed:** unifying «blank»
  behind one normalising predicate for every money draft is a behaviour change in
  the payment path (mark-only would become «nothing paid now»), so it wants its
  own ticket. `draftBlank` is the seed.
- **ASCII identity.** The strip only ever removes an edge mark;
  `normalizeArabicIndicDigits("123")` is `"123"` and every existing ASCII pin is
  re-run unchanged.
- **Mutation proof.** The pre-fix source for the pins was run against the new
  tests: leading-mark reader assertions fail (`parseWholeAmount("\u200f٥")` was
  `null`), and the mark-only override pin fails against the strip-only
  intermediate commit (it was accepted and priced `0`). The observed results are
  recorded in the review evidence for this SHA.

## Deliberately out of scope

- No display change: the draft string held in React state keeps the marks as
  pasted; only the reader drops the edge ones.
- The «one blank predicate» unification above (deferred).
