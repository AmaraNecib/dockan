import { describe, expect, it } from "bun:test";

import { FUZZY_MATCH_MIN_SCORE, foldArabic, fuzzySearchScore } from "@dokan/contracts";

/** The search fold is a search-only key: it never feeds identity matching. */
describe("foldArabic", () => {
  it("unifies every alef variant to bare alef", () => {
    for (const variant of ["أ", "إ", "آ", "ٱ", "ٲ", "ٳ"]) {
      expect(foldArabic(variant)).toBe("ا");
    }
  });

  it("unifies ya/ta-marbuta/hamza letter classes", () => {
    expect(foldArabic("ى")).toBe("ي");
    expect(foldArabic("ئ")).toBe("ي");
    expect(foldArabic("ة")).toBe("ه");
    expect(foldArabic("ؤ")).toBe("و");
  });

  it("keeps the diacritic / tatweel / zero-width stripping", () => {
    expect(foldArabic("بَطّــارية")).toBe(foldArabic("بطارية"));
    expect(foldArabic("علي\u200F")).toBe("علي");
    expect(foldArabic("علي\u061C")).toBe("علي");
    expect(foldArabic("  أحمد   أحمد ")).toBe("احمد احمد");
  });

  it("drops a leading definite article when a two-letter stem survives", () => {
    expect(foldArabic("اليوز")).toBe("يوز");
    expect(foldArabic("ليوز")).toBe("ليوز");
    // the owner's case: the folded query is a substring of the stored name
    expect(foldArabic("ليوز")).toContain(foldArabic("اليوز"));
    expect(foldArabic("زيت المحرك")).toBe("زيت محرك");
    expect(foldArabic("المحرك")).toBe("محرك");
  });

  it("keeps a short article word intact so it cannot match almost everything", () => {
    expect(foldArabic("ال")).toBe("ال");
    expect(foldArabic("الي")).toBe("الي");
    expect(foldArabic("الا")).toBe("الا");
    expect(foldArabic("")).toBe("");
  });

  it("folds a longer article word even when the result reads as another word", () => {
    // search-only over-fold of «الله» -> «له»; identity matching is untouched
    expect(foldArabic("الله")).toBe("له");
  });

  it("treats punctuation and separators as word breaks", () => {
    expect(foldArabic("ليوز-زبون")).toBe("ليوز زبون");
    expect(foldArabic("ليوز-زبون")).toBe(foldArabic("ليوز زبون"));
    expect(foldArabic("زيت/محرك 5W30")).toBe("زيت محرك 5w30");
  });
});

describe("fuzzySearchScore", () => {
  it("scores a one-letter typo above the fallback floor", () => {
    expect(fuzzySearchScore("بطارية", "بطلرية")).toBeGreaterThanOrEqual(FUZZY_MATCH_MIN_SCORE);
    expect(fuzzySearchScore("بطارية 60 أمبير", "بطلرية")).toBeGreaterThanOrEqual(FUZZY_MATCH_MIN_SCORE);
  });

  it("keeps an unrelated word below the floor", () => {
    expect(fuzzySearchScore("بطارية", "مفتاح")).toBeLessThan(FUZZY_MATCH_MIN_SCORE);
    expect(fuzzySearchScore("زيوت", "زيت")).toBeLessThan(FUZZY_MATCH_MIN_SCORE);
  });

  it("does not treat a related-but-different name as a typo", () => {
    // single insert/delete relatives score exactly at the floor; the fallback
    // requires strictly above, so they never qualify
    expect(fuzzySearchScore("محمود", "محمد")).toBeLessThanOrEqual(FUZZY_MATCH_MIN_SCORE);
    expect(fuzzySearchScore("كراسي", "كرسي")).toBeLessThanOrEqual(FUZZY_MATCH_MIN_SCORE);
  });

  it("returns zero when either side folds to nothing", () => {
    expect(fuzzySearchScore("بطارية", "")).toBe(0);
    expect(fuzzySearchScore("", "بطارية")).toBe(0);
  });

  it("is a perfect score for an identical fold", () => {
    expect(fuzzySearchScore("أحمد", "احمد")).toBe(1);
  });
});
