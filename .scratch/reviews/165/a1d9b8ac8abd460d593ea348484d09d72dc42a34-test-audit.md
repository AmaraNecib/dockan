# #165 — Test audit (PR #172 review-fix round 1)

Reviewed HEAD: `a1d9b8ac8abd460d593ea348484d09d72dc42a34` (`feat/165-arabic-search`)
Base: `c873e1635f104a5c95d673809060dbe8530b730e` (`origin/develop`)
Supersedes: `d1f885fd39502ff10dd25b9782e1852aa9d74203-test-audit.md` (kept as history).
Tier: Standard. Method: three-lens test audit over the Greptile fix delta, re-verified after the quality follow-up commit.

## Verdict

**A — no RED/ORANGE, no blockers.**

## What the review fix changed

Greptile found that the article stem guard is asymmetric: «الب» keeps its «ال»
(a one-letter stem is not folded away) while «البطارية» drops it, so a single
folded key hid the match. `arabicIncludes` now tries `{folded, article-preserved}`
on both sides, and `rankCatalog` (name + category) and `filterParties` (names)
use it. The guard itself is unchanged.

## Coverage of the fix

| Case | Where |
| --- | --- |
| «الب»→«البطارية», «اله»→«الهاتف الثابت» | `apps/api/src/lib/arabic-search.test.ts` (`arabicIncludes` block), `catalog-search.test.ts` (name + category tier), `party-match.test.ts`, e2e item + party steps |
| `foldArabicVariants` returns `[folded, preserved]` | `arabic-search.test.ts` |
| «اليوز»→«ليوز» (folded pair) still works | existing tests, unchanged |
| «احمد»→«أحمد», «مصطفي»→«مصطفى», «بطلرية»→«بطارية» | existing unit + e2e, unchanged |
| Identity guard (`normalizeTextKey("أحمد") !== normalizeTextKey("احمد")`) | `party-match.test.ts`, unchanged |
| Precision guards (زيت/زيوت, محمد/محمود, كرسي/كراسي) | `arabic-search.test.ts` + `party-match.test.ts` + `catalog-search.test.ts`, unchanged |
| Bare «ال» widening pinned as intentional | `arabic-search.test.ts` ("documents the bare-article widening") |

## Findings and resolutions (this round)

| Finding | Risk | Resolution |
| --- | --- | --- |
| Bare «ال» now matches every «ال»-prefixed name; unpinned | YELLOW | Pinned: `arabicIncludes("البطارية","ال") === true`, `arabicIncludes("بطارية","ال") === false`; documented in the design Risks |
| `rankCatalog` still carried a redundant `searchKey !== ""` guard | Note | Removed; `arabicIncludes` already returns false for an empty fold |
| Catalog JSDoc claimed matching used `normalizeTextKey` | Note | Corrected to describe the search fold |

## Remaining notes (accepted)

- A bare «ال» is an unanchored forward substring of the preserved key, so it also
  hits «ال…» mid-word. Same semantics as the pre-existing `.includes()`; pinned
  as intentional.
- `arabicIncludes` re-folds `rawQuery` per item; immaterial for shop-sized
  catalogs and only reached on the strict pass.
- The delta reviewer's ad-hoc root `bun test` reported failures in unrelated
  suites (SalePage, desktop vault broker); the documented gate (`bun run test`,
  turbo) is green and none of those files import the change.

## Commands

```
bun run typecheck   # exit 0
bun run lint        # exit 0
bun run test        # 740 pass / 0 fail (web); turbo 3/3 tasks successful
bun run test:e2e    # 50 passed
bun test apps/api/src/lib/arabic-search.test.ts apps/api/src/lib/catalog-search.test.ts  # 40 pass
bun test src/components/parties/party-match.test.ts (apps/web)                            # 19 pass
```
