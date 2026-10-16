# #227 — strip bidi formatting marks from money drafts (design)

- Tier: **High-assurance** in effect. The brief records Standard, and the delta
  is only *input normalisation*; but `docs/engineering-workflow.md` names «invoice
  & debt money calculations» High-assurance, #210 touched the same readers, and
  round 1 proved the change *did* move a billed amount (a mark-only override went
  from refused to free) — the exact reason #210 was High-assurance. So the
  High-assurance gates were run: **Debate**, test-audit and code-review. The
  design still notes the brief's label so the parent can confirm or re-label;
  the stricter gate is satisfied either way.
- Base (the stack): `origin/fix-210-arabic-indic-money` @ `afe15fe` — the PR
  #229 head. Merge-base with `origin/develop` is `a52084d1`. This lane is a
  stack on #229 as the brief requires: no rebase onto `develop`, nothing #229
  carries is re-implemented.
- Authority: commit only. This lane does **not** push and does **not** merge.

## Problem

`normalizeArabicIndicDigits` maps digits only, and every strict reader `trim()`s
(`trim` drops whitespace, not `Cf` format characters) but does not strip Unicode
bidi formatting marks. Copying Arabic-Indic digits out of RTL text commonly
carries an RLM (U+200F) or LRM (U+200E), so:

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
one reader module plus the test (§«Mysterious Name» in the review evidence) for
no behavioural gain, and would collide with the parallel `#225` lane that is
editing the same readers.

## Which marks, and why stripping is safe

Strip every code point with the Unicode `Bidi_Control` property — the characters
whose *only* purpose is to change the rendering order of text:

- U+061C ARABIC LETTER MARK (ALM)
- U+200E LEFT-TO-RIGHT MARK (LRM)
- U+200F RIGHT-TO-LEFT MARK (RLM)
- U+202A..U+202E (LRE, RLE, PDF, LRO, RLO) — embeddings/overrides
- U+2066..U+2069 (LRI, RLI, FSI, PDI) — isolates

The brief named at least ALM/LRM/RLM; the explicit embeddings and isolates are
the same kind of character (zero-width, invisible, directional-only), produced
by bidi-aware editors (Word/Excel/PDF copy) rather than by a keyboard. The
safety argument below applies to them unchanged, so excluding them would leave
the same paste bug reachable through a different code point. Widening costs
nothing: none of these can be a digit, a sign, a group separator or a decimal
separator.

**No legitimate money draft contains any of them.** A money draft is digits (one
of three scripts), an optional `-`, grouping separators (`,` whitespace, U+066C
Arabic thousands separator, U+00A0) and a decimal separator (`.` or U+066B) —
plus, on the loose reader, the `e`/`x`/`.` of `Number()`'s grammar. Every one of
those is a *visible* character; a `Bidi_Control` code point renders as nothing
and only exists to order a run of text. It therefore cannot be typed as part of
a number and can only be paste noise, so silently dropping it cannot turn one
owner's number into a different number — it can only turn a refusal into the
read the owner intended. Stripping is silent, with no warning, on that argument.

Deliberately **not** stripped:

- U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER and U+FEFF (ZWNBSP/BOM):
  invisible format characters, but not directional (`Bidi_Control` is false), so
  they are outside this ticket's scope. ZWSP/WJ still fail the strict readers —
  a safe refusal, never a wrong number. U+FEFF also fails the *strip*, but it is
  ECMAScript `WhiteSpace`, so `String.prototype.trim()` already dropped it before
  #227; that read-through is pre-existing and pinned, not something this strip
  handles.
- U+00A0 NBSP and U+066C/U+066B: legitimate separators, already the reader's
  grammar; stripping them here would delete a real separator and invent a
  different number.

## Interfaces / dependencies

No new export, no signature change, no dependency. `normalizeArabicIndicDigits`
gains one `.replace` of one module-private regex; callers and imports are
untouched.

## Planned tests

1. `apps/web/src/lib/amount-parse.test.ts` — a new `#227` describe:
   - `normalizeArabicIndicDigits` drops each of the twelve `Bidi_Control` code
     points (a loop, so a typo'd range cannot pass) and leaves a mark-free draft
     byte-identical (ASCII identity, and the legitimate `1٬000` unchanged).
   - a negative boundary: non-`Bidi_Control` invisibles (U+200B ZWSP, U+FEFF)
     are left untouched, so a future widening to `\p{Cf}` fails a pin.
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

- **Over-stripping.** Bounded by the `Bidi_Control` set: no marked code point is
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
  discount is legitimate and cannot bill a wrong number). The two refusals that
  face a *visually empty* field — a mark-only initial-payment draft surfaces
  «invalid payment» — are pre-existing (they refused before #227 too) and are
  unchanged here. **Deferred, not dismissed:** unifying «blank» behind one
  normalising predicate for every money draft is a behaviour change in the
  payment path (mark-only would become «nothing paid now»), so it wants its own
  ticket rather than a #227 side effect. `draftBlank` is the seed of that
  predicate and its doc comment says so.
- **ASCII identity.** The strip only ever removes a `Bidi_Control` code point;
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
- No display change: the draft string held in React state keeps the marks as
  pasted; only the reader strips them.
