# #165 — Code review (PR #172 review-fix round 1)

Reviewed HEAD: `a1d9b8ac8abd460d593ea348484d09d72dc42a34` (`feat/165-arabic-search`)
Base: `c873e1635f104a5c95d673809060dbe8530b730e` (`origin/develop`)
Supersedes: `d1f885fd39502ff10dd25b9782e1852aa9d74203-code-review.md` (kept as history).
Tier: Standard. Method: Standards + Spec axes over the Greptile fix delta, re-verified after the quality follow-up commit.

## Greptile finding addressed

> "Typing «الب» no longer finds «البطارية»; «اله» misses «الهاتف الثابت». Root cause: the fold drops a leading «ال» only when a ≥2-letter stem remains, so the query keeps its «ال» while the stored name drops it."

Fixed exactly as the brief prescribes: an **article-preserving** match alongside
the article-folded one. `foldArabicVariants(raw)` returns
`[article-folded, article-preserved]`; `arabicIncludes(text, query)` returns true
when any query key is a substring of any target key. Applied in
`rankCatalog` NAME and CATEGORY and in `filterParties` names. The short-word
guard (`MIN_ARTICLE_STEM = 2`) is unchanged — the article is not dropped
unconditionally.

## Standards

**Verdict: pass, no blockers.**

- **ADR-0007 separation holds.** `packages/contracts/src/core.ts` (`normalizeTextKey`) is not in the delta; identity callers (`duplicateNameParty`, `needsChoice`, phone matching) are untouched. `foldArabic`/`arabicIncludes` remain the separate search-only key.
- **No dead code.** `foldLetters` / `dropArticles` are composed by both public keys; `foldArabic` still feeds `fuzzySearchScore` and the catalog fuzzy gate; `foldArabicVariants` and `arabicIncludes` are both exercised. The redundant empty-key guard was removed.
- **Single shared matcher.** `arabicIncludes` is the one matching primitive for both call sites; no duplicated fold/match logic.
- **Naming and shape.** `arabicIncludes(text, query)` follows the haystack/needle convention, is documented, and the Set-based key dedupe keeps the empty query false.

## Spec

**Verdict: pass, no blockers.**

- Article-preserving match alongside the folded one, on both sides — implemented as specified.
- Applied in `rankCatalog` (name + category) and `filterParties` (names); barcode/phone/fuzzy paths untouched.
- Short-word guard kept: «ال» + one letter still does not fold to a one-letter key.
- Required tests added (§Tests of the brief): «الب»→«البطارية», «اله»→«الهاتف الثابت» (unit + Playwright); old positives «اليوز»→«ليوز», «احمد»→«أحمد», «مصطفي»→«مصطفى», «بطلرية»→«بطارية» still pass; identity and precision guards still hold.
- No scope creep: the delta touches the fold module, the two search call sites, their tests, the e2e spec, and the design doc.

## Notes (non-blocking)

- Bare «ال» now forward-matches any «ال…» name (never a name without the article); pinned as intentional.
- Catalog JSDoc was corrected in the follow-up commit; one phrase ("then normalized name") is mildly stale but disambiguated by the next sentence.

## Commands

```
git diff c873e1635f104a5c95d673809060dbe8530b730e...a1d9b8ac8abd460d593ea348484d09d72dc42a34
bun run typecheck && bun run lint    # exit 0
bun run test                         # 740 pass / 0 fail
bun run test:e2e                     # 50 passed
```
