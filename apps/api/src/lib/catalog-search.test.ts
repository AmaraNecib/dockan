import { describe, expect, it } from "bun:test";

import { normalizeBarcode, normalizeTextKey, type Category, type Item } from "@dokan/contracts";

import { rankCatalog } from "./catalog-search";

/** minimal item factory — only fields ranking reads are real */
const item = (id: string, name: string, overrides: Partial<Item> = {}): Item => ({
  id,
  name,
  barcode: null,
  categoryId: "cat-1",
  costPrice: 100,
  sellingPrice: 150,
  lowStockThreshold: 5,
  stockOnHand: 0,
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
  ...overrides,
});

const category = (id: string, name: string): Category => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
});

const CATEGORIES = [category("cat-1", "زيوت"), category("cat-2", "بطاريات")];

describe("normalizeBarcode", () => {
  it("accepts ASCII codes and uppercases them", () => {
    expect(normalizeBarcode("abc-123")).toBe("ABC-123");
    expect(normalizeBarcode("  6290123456789 ")).toBe("6290123456789");
  });

  it("strips zero-width and soft-hyphen junk before validating", () => {
    expect(normalizeBarcode("AB\u200BCD\u00AD12")).toBe("ABCD12");
  });

  it("rejects Arabic / IME output instead of storing mojibake", () => {
    expect(normalizeBarcode("بطارية")).toBeNull();
    expect(normalizeBarcode("٦٢٩")).toBeNull();
  });

  it("rejects empty and over-long codes", () => {
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("A".repeat(65))).toBeNull();
  });

  it("keeps a 3-char minimum", () => {
    expect(normalizeBarcode("AB")).toBeNull();
    expect(normalizeBarcode("ABC")).toBe("ABC");
  });
});

describe("normalizeTextKey", () => {
  it("folds case and whitespace", () => {
    expect(normalizeTextKey("  AAA   Bbb ")).toBe("aaa bbb");
  });

  it("strips tatweel and Arabic diacritics", () => {
    expect(normalizeTextKey("بَطّــارية")).toBe(normalizeTextKey("بطارية"));
  });
});

describe("rankCatalog", () => {
  const items = [
    item("i-oil", "زيت محرك"),
    item("i-bat", "بطارية 60 أمبير", { barcode: "6210001000017" }),
    item("i-bat2", "بطارية 70 أمبير", { barcode: "6210002000015" }),
    item("i-code39", "حساس", { barcode: "BC-99" }),
  ];

  it("exact barcode wins and is excluded from matches", () => {
    const result = rankCatalog(items, CATEGORIES, "6210001000017");
    expect(result.exact?.item.id).toBe("i-bat");
    expect(result.matches).toHaveLength(0);
  });

  it("exact barcode match is case-insensitive on the normalized code", () => {
    const result = rankCatalog(items, CATEGORIES, "bc-99");
    expect(result.exact?.item.id).toBe("i-code39");
  });

  it("ranks partial-barcode prefix above substring above name above category", () => {
    // "بطارية" matches two names AND the بطاريات category; a barcode prefix
    // query must still outrank them
    const byBarcodePrefix = rankCatalog(items, CATEGORIES, "6210001");
    expect(byBarcodePrefix.matches[0]?.matchedBy).toBe("BARCODE_PARTIAL");
    expect(byBarcodePrefix.matches[0]?.item.id).toBe("i-bat");

    const byName = rankCatalog(items, CATEGORIES, "60 أمبير");
    expect(byName.exact).toBeNull();
    expect(byName.matches.map((m) => m.item.id)).toEqual(["i-bat"]);
    expect(byName.matches[0]?.matchedBy).toBe("NAME");
  });

  it("matches category names in Arabic", () => {
    const generator = item("i-gen", "مولد كهربائي", { categoryId: "cat-2" });
    const result = rankCatalog([generator], CATEGORIES, "بطاريات");
    expect(result.matches[0]?.matchedBy).toBe("CATEGORY");
    expect(result.matches[0]?.item.id).toBe("i-gen");
  });

  it("ignores tatweel/diacritics noise in the query", () => {
    const result = rankCatalog(items, CATEGORIES, "بَطّــارية 60");
    expect(result.matches.map((m) => m.item.id)).toContain("i-bat");
  });

  it("prefix beats substring within the same partial tier", () => {
    const prefixed = [item("p1", "أ", { barcode: "7770" }), item("p2", "ب", { barcode: "1777" })];
    const result = rankCatalog(prefixed, [], "777");
    expect(result.exact).toBeNull();
    expect(result.matches.map((m) => m.item.id)).toEqual(["p1", "p2"]);
    expect(result.matches.map((m) => m.matchedBy)).toEqual(["BARCODE_PARTIAL", "BARCODE_PARTIAL"]);
  });

  it("applies the limit to matches but never to exact", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`x${i}`, `منتج ${i}`, { barcode: `X${String(i).padStart(3, "0")}` }));
    const result = rankCatalog(many, [], "x0", 5);
    expect(result.matches.length).toBe(5);
    const exact = rankCatalog(many, [], "X000".toLowerCase());
    expect(exact.exact?.item.id).toBe("x0");
    expect(exact.matches.length).toBeLessThanOrEqual(5);
  });

  it("folds alef/ya variants and the definite article in the query", () => {
    const folded = [
      item("i-lyo", "ليوز"),
      item("i-ahmed", "أحمد"),
      item("i-mustafa", "مصطفى"),
    ];
    expect(rankCatalog(folded, [], "اليوز").matches.map((m) => m.item.id)).toEqual(["i-lyo"]);
    expect(rankCatalog(folded, [], "احمد").matches.map((m) => m.item.id)).toEqual(["i-ahmed"]);
    expect(rankCatalog(folded, [], "مصطفي").matches.map((m) => m.item.id)).toEqual(["i-mustafa"]);
  });

  it("folds the stored name too: a bare query finds an article-prefixed name", () => {
    const items = [item("i-art", "البطارية"), item("i-plain", "بطارية")];
    expect(rankCatalog(items, [], "بطارية").matches.map((m) => m.item.id)).toEqual(["i-art", "i-plain"]);
  });

  it("ranks strict matches before the typo fallback", () => {
    const items = [item("i-fuzzy", "بطلرية"), item("i-strict", "بطارية 60 أمبير")];
    const result = rankCatalog(items, [], "بطارية");
    // the strict substring match stays first; the edit-distance hit is appended
    expect(result.matches.map((m) => m.item.id)).toEqual(["i-strict", "i-fuzzy"]);
  });

  it("does not add fallback noise when the strict hits already fill the limit", () => {
    const items = [item("i-strict", "بطارية"), item("i-fuzzy", "بطلرية")];
    const result = rankCatalog(items, [], "بطارية", 1);
    expect(result.matches.map((m) => m.item.id)).toEqual(["i-strict"]);
  });

  it("does not append a related-but-different name beside the strict hit", () => {
    const items = [item("i-mohamed", "محمد"), item("i-mahmoud", "محمود")];
    const result = rankCatalog(items, [], "محمد");
    expect(result.matches.map((m) => m.item.id)).toEqual(["i-mohamed"]);
  });

  it("falls back to an edit-distance hit when the strict pass finds nothing", () => {
    const items = [item("i-battery", "بطارية")];
    const result = rankCatalog(items, [], "بطلرية");
    expect(result.exact).toBeNull();
    expect(result.matches.map((m) => m.item.id)).toEqual(["i-battery"]);
    expect(result.matches[0]?.matchedBy).toBe("NAME");
  });

  it("returns empty for blank queries", () => {
    expect(rankCatalog(items, CATEGORIES, "   ")).toEqual({ exact: null, matches: [] });
  });
});
