# #227 — strip bidi formatting marks from money drafts (design)

- Tier: **High-assurance**. Justification (one line): the diff sits on the
  invoice-total computation path (a sale line's price override feeds the total),
  so it can violate failure mode (2) «a total is computed wrongly» — round 1 of
  this lane *did* move a billed amount (a mark-only override went from refused to
  a free line). Per the workflow the tier follows the failure mode, not the diff
  size; the brief recorded Standard, and the failure-mode read plus the #210
  precedent (same readers) make High-assurance the defensible tier. The
  High-assurance gates therefore ran: **Debate**, test-audit and code-review.
- Base: `origin/develop` @ `c3f8544`. PR #229/#210 was **merged into `develop`
  while this lane ran**, so the brief's stack base (`origin/fix-210-arabic-indic-money`
  @ `afe15fe`) is no longer the base: the three lane commits were rebased onto
  the current `origin/develop` (merge-base with the old base is `a52084d1`).
  Overlap analysis: `git diff origin/develop...HEAD` touches only the 6 #227
  files; no #229-owned file is re-touched, and `develop` contains neither
  `BIDI_CONTROL` nor `draftBlank`, so nothing is duplicated from the merged
  #210/#229 content.
- Authority: commit only. This lane does **not** push and does **not** merge.

## Problem

`normalizeArabicIndicDigits` maps digits only, and every strict reader `trim()`s
(`trim` drops ECMAScript `WhiteSpace`; the bidi marks are `Cf` format characters,
and `Cf` is not `WhiteSpace`, so `trim` cannot drop them) but does not strip
Unicode bidi formatting marks. Copying Arabic-Indic digits out of RTL text
commonly carries an RLM (U+200F) or LRM (U+200E), so:

- `parseWholeAmount("\u200f٥")` → `null` (expected 5)
- `parseWholePercentage("\u200f١٠٠")` → `null` (expected 100)

Same class #210 set out to remove — «refuses a number the owner can read» —
reached by paste instead of by keyboard, which is the more common path for this
user.

## Where the strip lives

`normalizeArabicIndicDigits` in `apps/web/src/lib/amount-parse.ts` is the one
normalisation step every reader already shares (established in #198, kept by
#210; #229 changed tests only and established no new place). Every affected
reader funnels through it:

| reader | file |
| --- | --- |
| `normalizeArabicIndicDigits` | `lib/amount-parse.ts` |
| `parseWholeAmount` | `lib/amount-parse.ts` |
| `parseWholePercentage` | `lib/amount-parse.ts` |
| `parseLooseNumber` | `lib/amount-parse.ts` |
| `parseGroupedAmount` (and `STRIP_GROUPING`) | `lib/amount-parse.ts` |
| `parseQuantityDraft` | `lib/invoice-draft.ts` |

Adding the strip there and nowhere else means the paste fix cannot be half
applied *to a reader that normalises*: all of them are covered. Readers that
bypass the normalizer remain ASCII-only and are named under «Deliberately out of
scope» below (#225). The function keeps its exported name because the brief
names it, and only one production module (`lib/invoice-draft.ts`) imports the
function itself (the test imports it too; ~15 modules import the module). The
doc comment now states the widened contract where the name under-describes it.
A rename (`normalizeMoneyDraft`) was considered and rejected: it would churn the
one reader module plus the test for no behavioural gain, and would collide with
the `#225` lane that edits the same readers.

## Which marks, and why stripping is safe

Strip the zero-width directional marks a paste carries that cannot change
*which* number the owner typed:

- U+061C ARABIC LETTER MARK (ALM)
- U+200E LEFT-TO-RIGHT MARK (LRM)
- U+200F RIGHT-TO-LEFT MARK (RLM)
- U+202A..U+202C (LRE, RLE, PDF) — embeddings and their terminator
- U+2066..U+2069 (LRI, RLI, FSI, PDI) — isolates

The brief named at least ALM/LRM/RLM; the embeddings, PDF and isolates are the
same kind of character (zero-width, invisible, directional-only), produced by
bidi-aware editors (Word/Excel/PDF copy) rather than by a keyboard. For all ten
the safety argument below holds unchanged, so excluding them would leave the
same paste bug reachable through a different code point.

**Excluded on purpose: the directional overrides U+202D (LRO) and U+202E
(RLO).** They are `Bidi_Control` too, but an override renders the following run
in *forced* order, so a digit run inside one is displayed reversed (`123` shows
as `321`) while the logical characters a paste carries are still `123`. Dropping
the override would read a different number from the one the owner saw — exactly
the failure this ticket exists to remove. So they stay: a draft carrying one
fails the strict readers, a safe refusal, never a different number. (This is the
one narrowing the first review round surfaced; the earlier draft stripped all
twelve `Bidi_Control` code points and claimed number-preservation for all of
them.)

**No legitimate money draft contains any of the ten.** A money draft is digits
(one of three scripts), an optional `-`, grouping separators (`,` whitespace,
U+066C Arabic thousands separator, U+00A0) and — on the loose reader only — the
`e`/`x`/`.` of `Number()`'s grammar. Every one of those is a *visible*
character; any of the ten marks renders as nothing and only exists to order a run
of text. It therefore cannot be typed as part of a number and can only be paste
noise, so silently dropping it cannot turn one owner's number into a different
number — it can only turn a refusal into the read the owner intended. Stripping
is silent, with no warning, on that argument.

Deliberately **not** stripped:

- U+202D LRO and U+202E RLO: `Bidi_Control`, but they can reverse the displayed
  run — see above. Refused, not removed.
- U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER and U+FEFF (ZWNBSP/BOM):
  invisible format characters, but not `Bidi_Control`, so they are outside this
  ticket's scope. ZWSP/WJ still fail the strict readers — a safe refusal, never a
  wrong number. U+FEFF also survives the *strip*, but it is ECMAScript
  `WhiteSpace`, so `String.prototype.trim()` already dropped it before #227; that
  read-through is pre-existing and pinned, not something this strip handles.
- U+00A0 NBSP and U+066C: legitimate grouping separators in the reader's
  grammar. U+066B (Arabic decimal separator) is a *visible* numeric separator, not
  a bidi mark, so stripping it would delete a real separator and invent a
  different number (`٥٫٥` → `55`) — no reader accepts it today, but that is a
  refusal, not a licence to delete it.

## Interfaces / dependencies

No new export, no signature change, no dependency. `normalizeArabicIndicDigits`
gains one `.replace` of one module-private regex; callers and imports are
untouched. As a consequence of that strip, `lib/invoice-draft.ts` also gains the
private `draftBlank` predicate and uses it at the two override sites
(`saleUnitPrice`, `saleOverrideInvalid`), so a mark-only draft is «nothing
chosen» in both — see the Risks section.

## Planned tests

1. `apps/web/src/lib/amount-parse.test.ts` — a new `#227` describe:
   - `normalizeArabicIndicDigits` drops each of the ten stripped marks (a loop,
     so a typo'd range cannot pass) and leaves a mark-free draft byte-identical
     (ASCII identity, and the legitimate `1٬000` unchanged).
   - both strip boundaries: non-`Bidi_Control` invisibles (U+200B ZWSP, U+2060
     word joiner, U+FEFF BOM) and the LRO/RLO overrides U+202D/U+202E are left
     untouched, so a future widening to `\p{Cf}` or to the full property fails a
     pin. U+FEFF is additionally pinned as *reading through*
     (`parseWholeAmount("\ufeff5")` = 5) because it is ECMAScript `WhiteSpace`
     and `trim()` — not this strip — drops it.
   - each reader: `parseWholeAmount`, `parseWholePercentage`,
     `parseGroupedAmount`, `parseLooseNumber`.
   - the ASCII-identity case: `parseWholeAmount("\u200f123")` = `123` and plain
     `123` unchanged, asserted equal to each other.
   - a paste-shaped case: the mark is **built** (`const RLM = "\u200f"` +
     digit string), never typed as an invisible literal. Marks are pinned
     leading, trailing and mid-number (a mid-number mark concatenates:
     `1\u200f2` = 12).
   - negative controls: a mark-only draft still refuses; a marked decimal and a
     marked sign still refuse on the strict readers; an embedded mark cannot
     legalise *visible* bad grouping (`1,\u200f5` → null) though it does read
     visible-valid grouping (`1,\u200f000` → 1000).
2. `apps/web/src/lib/invoice-draft.test.ts` — `parseQuantityDraft` pinned with a
   pasted draft, the sale money path behind it (`saleUnitPrice`,
   `saleOverrideInvalid`, `discountAmountFor`, `resolveInitialPaid`), and the
   mark-only override pinned as invalid + default-priced (the regression above).
3. `tests/e2e/sale-checkout.spec.ts` — a paste-shaped end-to-end pin: the sale
   quantity, price override and discount are filled with RLM-prefixed
   Arabic-Indic text, the totals are asserted, and the invoice saves. `.fill()`
   sets the value in one shot (paste-shaped, not key-by-key).

## Implementation risks

- **Over-stripping.** Bounded by the ten-mark set: no stripped code point is
  part of any reader's grammar, and the negative controls above prove the strip
  cannot legalise a draft whose *visible* text is malformed grouping or a
  mark-only draft. (An embedded mark inside `1,<mark>000` does read as `1000` —
  the visible text is the valid `1,000`, the correct read, not a legalised
  malformed draft.)
- **A normalisation that empties a non-empty draft.** Stripping turns `"\u200f"`
  into `""`, and two guards in `lib/invoice-draft.ts` tested blankness on the raw
  `.trim()` (a bidi mark is `Cf`, not whitespace). Left alone, a mark-only sale
  override would have parsed to `0` and billed the line free — the hole
  `saleOverrideInvalid` exists to close. Both now share a `draftBlank` predicate
  that blanks through the same normalizer; the pins assert the mark-only override
  is refused and prices at the default, not zero.
- **"Blank" is not yet one concept, and a mark-only draft is not refused
  everywhere.** The remaining raw-`.trim()` guards were audited: each either
  refuses a mark-only draft (`percentageDraftInvalid`, `resolveInitialPaid`,
  `parseReturnQuantities`, `parseCashBackDraft`, `saleDebt`) or reads it as the
  empty value (`discountAmountFor` / the sale discount guard, where a zero
  discount is legitimate and cannot bill a wrong number). The refusals that face
  a *visually empty* field — a mark-only initial-payment draft surfaces
  «invalid payment», and a mark-only percentage draft is reported invalid rather
  than empty — are pre-existing (they refused before #227 too) and are unchanged
  here. **Deferred, not dismissed:** unifying «blank» behind one
  normalising predicate for every money draft is a behaviour change in the
  payment path (mark-only would become «nothing paid now»), so it wants its own
  ticket rather than a #227 side effect. `draftBlank` is the seed of that
  predicate and its doc comment says so.
- **ASCII identity.** The strip only ever removes one of the ten marks;
  `normalizeArabicIndicDigits("123")` is `"123"` and every existing ASCII pin is
  re-run unchanged.
- **Mutation proof.** Manual and local-only: revert the strip, observe the #227
  pins fail, restore; confirm `git diff` clean before commit.

## Deliberately out of scope

- `nextUnitCost` (purchase unit-cost field) calls `Number(value)` directly, so
  it bypasses the normalizer and still ignores the previous value for a marked
  or Arabic-Indic paste. That is the #225 ticket's "remaining ASCII-only
  readers" scope, not this strip; no reader changes here.
- `parseWholeNumber` / `parseSignedWholeNumber` in `lib/numeric-input.ts`
  (opening-stock fields) — same #225 boundary.
- The quick-add price drafts (`sale.tsx` `Number(fields.cost/sell)`, `purchase.tsx`
  `Number(fields.unitCost/sellPrice)`) are ASCII-only money drafts that bypass the
  normalizer, so a pasted Arabic-Indic or marked value does not reach them. Same
  #225 boundary; named so the partial coverage is visible, not implied.
- No display change: the draft string held in React state keeps the marks as
  pasted; only the reader strips them.
