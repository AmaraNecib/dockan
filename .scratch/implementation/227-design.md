# #227 — accept a pasted Arabic-Indic number: drop edge bidi marks (design)

- Tier: **High-assurance**. Justification: the diff sits on the invoice-total
  computation path (a sale line's price override feeds the total), so it can
  violate failure mode (2) «a total is computed wrongly» — round 1 of this lane
  *did* move a billed amount (a mark-only override went from refused to a free
  line), and the same class is what the final round closed. Per the workflow the
  tier follows the failure mode, not the diff size. The brief recorded Standard;
  the failure-mode read makes High-assurance the defensible tier, and the
  High-assurance gates ran: **Debate**, test-audit and code-review.
- Base: `origin/develop` @ `6708324`. The brief's stack base
  (`origin/fix-210-arabic-indic-money` @ `afe15fe`) was **merged into `develop`
  while this lane ran** (PR #229/#210), and `develop` has since also merged
  #225 (`nextUnitCost` + the remaining ASCII-only readers) and #226, then #235
  (workflow docs). The lane commits were rebased onto the current `origin/develop`
  (@ `6708324`); merge-base with the old base is `a52084d1`.
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
The function keeps its exported name because the brief names it, and only two
production modules (`lib/invoice-draft.ts`, `lib/numeric-input.ts`) import the
function itself (~17 modules import the module). The doc comment now states the
widened contract where the name under-describes it. A rename (`normalizeMoneyDraft`) was considered and
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
(Word/Excel/PDF copy). At the edge all ten are number-preserving — measured for
RLM (the ticket's case); the rest have the same edge shape, where no digit run is
split.

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

- Interior ALM/RLM and the RTL isolates LRI/RLI/FSI/PDI can reorder a digit run
  (see the table). The interior LRM/LRE/RLE/PDF do *not* reorder two adjacent
  digits, but can still reorder a grouped run — and the rule keys on position
  anyway, so every interior mark is refused with the rest: a lost acceptance,
  never a lost value. Refused, not removed.
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
   `apps/web/src/lib/numeric-input.test.ts` gets the same edge/interior pins for
   the #225-routed `parseWholeNumber` / `parseSignedWholeNumber` /
   `resolveOpeningStock`, so every reader the shared normalizer reaches is
   pinned.
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
- **"Blank" is not yet one concept.** The remaining blank guards were audited.
  `percentageDraftInvalid` (`amount-parse.ts`) and `resolveInitialPaid`
  (`invoice-draft.ts`) still test blankness on the raw `.trim()`, so each refuses
  a mark-only draft; `parseReturnQuantities` and `parseCashBackDraft` have no raw
  `.trim()` guard and reach the same refusal through the normalising readers (i.e.
  through this strip); `saleDebt` refuses via `parseGroupedAmount`; and
  `discountAmountFor` / the sale discount guard read a mark-only draft as the
  empty value (a zero discount, legitimate and unable to bill a wrong number).
  The refusals that face a *visually empty* field — a mark-only initial-payment
  draft surfaces «invalid payment», a mark-only percentage draft is reported
  invalid — are pre-existing and unchanged. **Deferred, not dismissed:** unifying
  «blank» behind one normalising predicate for every money draft is a behaviour
  change in the payment path (mark-only would become «nothing paid now»), so it
  wants its own ticket. `draftBlank` is the seed.
- **One reader changes a *value*, not just acceptance: `nextUnitCost`.** With #225
  it reads through the normaliser, so an edge-marked draft now returns the
  cleared-field zero where pre-#227 it kept the previous cost. That is consistent
  with that field's own documented «a cleared field is an explicit zero» contract
  (a mark-only field looks empty) and the unit cost has no «free line» hole, but
  it is a money-field behaviour change and is pinned and documented on the
  reader. No other reader changes a read value: they accept or refuse.
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

---

# Round 2 — the signed reader defeats the interior-mark rule (PR #239 Greptile)

- Tier: **High-assurance** (unchanged). Justification: the reader under fix is the
  stock movement delta (`stock.tsx` submit → `stockAddManual`), so a wrong read
  can drive stock below zero or record a removal the owner did not type —
  failure mode (1), the same money/quantity class round 1 recorded. The tier
  follows the failure mode, not the diff size.
- Base for the round's delta: PR #239 head `baa4cfa` (code head `e472d5b`); the
  PR's merge-base with `origin/develop` is `6708324`. Round 1 fired on `develop`
  `6708324` and `develop` has since taken `#113`; this round does not rebase —
  the parent owns the pre-merge rebase, and rebasing would rewrite the round-1
  commits the PR history already carries.
- Authority: commit only. The lane does **not** push, open a PR or merge.

## The finding

`apps/web/src/lib/numeric-input.ts:56` (round-1 line). `parseSignedWholeNumber`
ran `trim()` and then **stripped the `-` before normalising** the magnitude:

```ts
const trimmed = text.trim();
if (trimmed.startsWith("-")) {
  const magnitude = parseWholeNumber(trimmed.slice(1)); // normalises HERE
  ...
```

`parseWholeNumber` calls the shared `normalizeArabicIndicDigits`, whose
`stripEdgeBidiMarks` decides edge-vs-interior by the first and last *content*
character. `-` is content, so in the signed draft `"-\u200f5"` the mark is
interior and would be kept — but by the time the normaliser ran, the `-` had
already been sliced off, so the mark looked leading and was stripped. The stock
form then accepted `-5` and submitted a removal the interior-mark rule exists to
refuse: **the rule and the code agreed on the documented case and disagreed on a
reachable one.**

Pre-fix behaviour, stated explicitly: `parseSignedWholeNumber("-\u200f5")`
returned **`-5`** (must be `null`). Its unsigned siblings
(`parseWholeNumber("-\u200f5")`, `parseWholeAmount`, `parseLooseNumber`) already
refused it.

## The fix

Normalise the **whole signed draft** first, judge it, and only then remove the
sign. `-` is content to `stripEdgeBidiMarks`, so a mark that was interior in the
signed draft is still interior when the shared normaliser runs, and the strict
digits test refuses it. The magnitude is read through a new private
`readNormalizedDigits` that only tests and converts — it never normalises — so
the edge strip cannot run a second time on a string whose sign has just left. One
normaliser remains; `readNormalizedDigits` is a read, not a second normaliser.

`parseWholeNumber` now delegates to the same `readNormalizedDigits`
(`readNormalizedDigits(normalizeArabicIndicDigits(text).trim())`), so there is
still exactly one strict-read implementation and no drift.

What is deliberately **not** changed: a mark *in front of the sign*
(`"\u200f-٥"`) stays refused. Round 1 pinned that as a safe refusal, and
accepting it would be a separate behaviour change (an edge mark before a sign)
that wants its own browser proof of display order. This round only re-classifies
interior marks; it does not widen the strip and it does not widen acceptance
beyond the finding.

## Class sweep — every reader that splits, trims or removes before normalising

`stripEdgeBidiMarks` keys edge-vs-interior on the first/last **content**
position, where content is “not whitespace and not a mark”. A pre-step turns an
interior mark into an edge mark only if it removes **content** from one side of
it. Whitespace is not content, so `.trim()` before normalising cannot re-parent a
mark; a removed **sign** or **separator** is content and can.

| reader / call site | pre-normalisation step | affected? | why |
| --- | --- | --- | --- |
| `parseSignedWholeNumber` (`numeric-input.ts`) | `startsWith("-")` + `slice(1)` | **YES — fixed** | removes the content `-` before normalising, re-parenting an interior mark to the magnitude edge |
| `parseWholeNumber` (`numeric-input.ts`) | `.trim()` after normalise | no | trim drops only whitespace (non-content); normalisation runs on the whole draft |
| `parseWholeAmount` / `parseWholePercentage` (`amount-parse.ts`) | `.trim()` after normalise | no | same |
| `parseLooseNumber` (`amount-parse.ts`) | none (`Number(normalize(...))`) | no | normalises the whole draft; an interior mark survives as `Cf` and `Number` yields `NaN` |
| `parseGroupedAmount` (`amount-parse.ts`) | `.trim()`; `STRIP_GROUPING` | no | separator removal runs **after** the grouping regex has already rejected any draft containing a mark, so it never sees one |
| `percentageDraftInvalid` (`amount-parse.ts`) | `draft.trim()` blank test | no | whitespace only; `parseWholePercentage` still normalises the whole draft |
| `parseQuantityDraft` (`invoice-draft.ts`) | `.trim()` after normalise | no | same as `parseWholeNumber` |
| `draftBlank` (`invoice-draft.ts`) | `.trim()` after normalise | no | same |
| `nextUnitCost` (`invoice-draft.ts`) | none — `parseLooseNumber` | no | round 1's one *value* change (mark-only → cleared-field zero) stands, disclosed + pinned; the ordering class does not reach it |
| `resolveOpeningStock` (`numeric-input.ts`) | `text.trim()` before `parseWholeNumber` | no | trims whitespace only; `parseWholeNumber` normalises the whole remainder, and a sign is never split |
| page wrappers (`invoice.tsx`, `items.tsx`, `sale.tsx`, `supplier-opening-draft.ts`) | `.trim()` blank checks / `.trim()` before a reader | no | whitespace only; the readers still normalise their whole input |
| `.replace()` before a money read | none in a money reader | no | the only pre-normalisation `replace` is `STRIP_GROUPING` (after validation); the `auth-client.ts` `\D` strip is the phone reader, out of scope |

**Result of the sweep: exactly one affected reader, `parseSignedWholeNumber`.**
Its only production consumer is the stock movement delta in
`apps/web/src/pages/stock.tsx` (submit + the removal/cost-field switch), which is
why the tier stays High-assurance.

## Planned tests

- `apps/web/src/lib/numeric-input.test.ts` — a dedicated ordering pin:
  - `normalizeArabicIndicDigits("-\u200f5")` **keeps** the mark (proof it was
    interior to the signed draft), and
  - `parseSignedWholeNumber("-\u200f5")` is `null` for both Arabic digit scripts
    and a grouped interior mark,
  - positive controls: an edge mark still strips (`"\u200f٥"` → 5), `-5` and
    `-٥` still read.
  The value assertion is the *ordering* detector: re-create the old two-step
  order and it fails with `-5` where `null` is required.
- No new e2e: the affected consumer (stock form) has no flow in
  `sale-checkout.spec.ts`; the round's verification re-runs that spec to prove the
  shared readers did not move. The unit pin is the regression gate.

## Implementation risks

- **A second normalisation hiding the first.** The whole risk is that some path
  still normalises after the sign/separator comes off. `readNormalizedDigits`
  is named for the contract and is the only strict read; a comment on
  `parseSignedWholeNumber` states the ordering, and the mutation proof shows the
  pin fails when it is violated.
- **Behaviour drift on `"- 5"`.** The magnitude still `.trim()`s, so the
  pre-existing acceptance of a space between sign and digits is preserved.
- **The round-1 leading-edge refusal.** Preserved deliberately (see above), so no
  existing round-1 pin is weakened.

## Mutation proof (plan; observed results go in the evidence file)

1. Re-create the round-1 order in `parseSignedWholeNumber`
   (`parseWholeNumber(trimmed.slice(1))` after `startsWith("-")`).
2. Run `bun test apps/web/src/lib/numeric-input.test.ts`.
3. Show the ordering pin fails with `-5` vs `null` and the reason.
4. Revert; confirm `git status` clean and the suite green.

## Deliberately out of scope (round 2)

- `\u200f-٥` (edge mark before a sign) stays a refusal; accepting it is its own
  behaviour change with an RTL display-order proof.
- The round-1 «one blank predicate» deferral (`percentageDraftInvalid`,
  `resolveInitialPaid`) is unchanged.
