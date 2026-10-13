# #165 — Arabic search: fold alef/ya/«ال» everywhere, typo tolerance as a fallback

**Tier:** Standard (shared search logic + UI list filtering).
**Base:** `origin/develop` @ `c873e1635f104a5c95d673809060dbe8530b730e`.
**Branch:** `feat/165-arabic-search`.

## Problem

Search canonicalises text with `normalizeTextKey` (NFC, lowercase, strip
zero-width/diacritics/tatweel), then does a plain `.includes()`. That does not
fold alef/ya/ta-marbuta variants or the definite article «ال», so the owner's
`اليوز` does not find `ليوز`, `احمد` does not find `أحمد`, `مصطفي` does not find
`مصطفى`. There is also no typo tolerance, so `بطلرية` finds nothing.

Identity matching (`duplicateNameParty`, `phoneMatchParty`, the picker's
`needsChoice`) deliberately uses `normalizeTextKey` and must keep treating
`أحمد` / `احمد` as two different debtors (ADR-0007 debt grouping). The search
fold is therefore a **separate** function; identity is untouched.

## Interfaces

**New module** `packages/contracts/src/arabic-search.ts`, re-exported from
`packages/contracts/src/index.ts`. Search-only; never an identity key.

```ts
/** Canonical search key: NFC, lowercase, strip bidi/zero-width, tatweel and
 * harakat, unify alef/ya/ta-marbuta/hamza forms, turn punctuation/separators
 * into word breaks, and drop a leading «ال» from each word that still has at
 * least two letters after it. `foldArabic("اليوز") === "يوز"`. */
export function foldArabic(raw: string): string;

/** Minimum similarity for a typo-fallback match; the fallback requires a
 * score strictly above it. */
export const FUZZY_MATCH_MIN_SCORE: number; // 0.8

/** Best typo-tolerance similarity of a query against a text, 0..1. Normalized
 * Levenshtein distance against the whole folded text and each of its words
 * (an in-order/subsequence hit is the deletion-only case of that distance).
 * 0 when either side folds to "". */
export function fuzzySearchScore(text: string, query: string): number;
```

Letter classes folded (each covered by a unit test):
`أ إ آ ٱ ٲ ٳ → ا`, `ى ئ → ي`, `ة → ه`, `ؤ → و`. The existing diacritic /
tatweel / zero-width stripping is kept (same ranges as `normalizeTextKey`).
Standalone hamza `ء` is left intact — folding it away would merge distinct
words for no required case. Punctuation and separators become word breaks, so
`ليوز-زبون` and `ليوز زبون` share one key.

**`normalizeTextKey` is not touched.** It stays the identity key.

## Where the search fold is applied

1. **Catalog** — `apps/api/src/lib/catalog-search.ts` (`rankCatalog`):
   name and category matching switch from `normalizeTextKey` to `foldArabic`.
   Barcode matching is unchanged (`normalizeTextKey(query).toUpperCase()`).
2. **Party list + picker** — `apps/web/src/components/parties/party-match.ts`
   (`filterParties`): name matching switches to `foldArabic`. Phone matching is
   unchanged.
   The picker's exact-name `needsChoice` check and `duplicateNameParty` /
   `phoneMatchParty` keep `normalizeTextKey` (identity, ADR-0007).
3. **Expenses / activity** — no text search exists today (expenses filter by
   category + window, activity is a capped list). Nothing to wire; recorded
   here so the audit does not treat it as a miss.

## Typo tolerance (fallback)

`rankCatalog` keeps its strict pass exactly as today (exact barcode >
partial barcode > name > category). Only when the strict pass leaves room
(`scored.length < limit`) does it run the fuzzy pass over items that did **not**
strict-match: `fuzzySearchScore` **strictly above** `FUZZY_MATCH_MIN_SCORE` is
appended with a rank after every strict tier, ordered by descending score.
Strict matches are never reordered or displaced. The fuzzy item is reported
through the existing `NAME` / `CATEGORY` `matchedBy` kind (whichever scored
higher) — no contract or UI change.

`filterParties` has no limit, so it runs the fuzzy pass only when the strict
pass found nothing (and the query is not phone-shaped). Strict matches always
win; the fallback only replaces an empty result.

The 0.8 floor (strictly above) is deliberate: `زيت`/`زيوت` (0.75) and the
single-insert/delete relatives `محمد`/`محمود` and `كرسي`/`كراسي` (exactly 0.8)
stay out, so existing precision is preserved; `بطلرية`/`بطارية` (0.833)
qualifies. Normalized edit distance already covers the deletion/subsequence
case, so there is no separate subsequence branch to keep dead.

## Dependencies

None added. New module only uses the standard string API.

## Planned tests

*Unit — `apps/api/src/lib/arabic-search.test.ts` (new, `bun:test`):*
every letter class (`أ إ آ ٱ ٲ ٳ → ا`, `ى/ئ → ي`, `ة → ه`, `ؤ → و`), the
article case (`foldArabic("اليوز") === "يوز"`, and `"يوز"` is contained in
`foldArabic("ليوز")`; a short `الي` is left intact so it cannot match
anything), punctuation as a word break, and kept diacritic/tatweel/zero-width
stripping. Fuzzy: `fuzzySearchScore("بطارية", "بطلرية")` above the floor, and
`زيت`/`زيوت`, `محمد`/`محمود`, `كرسي`/`كراسي` at or below it.

*Unit — `apps/api/src/lib/catalog-search.test.ts`:* `اليوز` query finds a
`ليوز` item; `احمد` query finds `أحمد`; `مصطفي` finds `مصطفى`; strict-first /
fallback-second ordering (a strict `NAME` match before a fuzzy-only match);
the fallback runs when strict is empty; a related-but-different `محمود` is
**not** appended beside a strict `محمد`; strict barcode ranking unchanged.

*Unit — `apps/web/src/components/parties/party-match.test.ts`:* the same fold
cases through `filterParties`; **identity guard** — `normalizeTextKey("أحمد") !==
normalizeTextKey("احمد")`, `duplicateNameParty("احمد", null, [أحمد])` is
undefined (no false same-name warning), while `filterParties([أحمد], "احمد")`
still finds the record; fuzzy fallback finds `بطلرية` → `بطارية`; existing
phone/diacritic cases unchanged.

*E2E — `tests/e2e/arabic-search.spec.ts` (new):* seed items and customers
named `…ليوز…`, then type `اليوز` in the items catalog search and in the
parties search and assert the folded match is visible **and an unrelated
record stays absent**; also assert `احمد` finds `أحمد`, `مصطفي` finds
`مصطفى`, and the typo fallback `بطلرية` finds `بطارية`.

## Risks

- **Precision.** Folding per word can over-match short fragments. Mitigated:
  forward `.includes()` only (no bidirectional match), the article is dropped
  only when a two-letter stem survives, punctuation becomes a word break, and
  the fuzzy pass never runs ahead of strict matches, never runs for
  phone-shaped queries, and requires a score strictly above the 0.8 floor
  (excluding insert/delete relatives such as `محمد`/`محمود`).
- **Coverage of the fuzzy pass.** The `>`-floor decision was driven by the
  indistinguishable-name case; no test can prove every possible related name is
  excluded, so `بطلرية`/`بطارية` is pinned as the positive case and
  `محمد`/`محمود` + `كرسي`/`كراسي` as the negatives.
- **Existing E2E count.** The catalog picker asserts exactly one option for
  `زيت`; the floor keeps `زيوت` (0.75) out. The `catalogSearch` fuzzy pass only
  tops up when strict results are below the limit and appends after strict
  matches.
- **Identity drift.** The guard test pins alef variants as distinct identity
  keys; only `foldArabic` folds them.
- **Performance.** The fuzzy pass is O(items × words × len²) over in-memory
  lists (hundreds of rows); acceptable and only reached when strict results
  are few.
