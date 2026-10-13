import { FUZZY_MATCH_MIN_SCORE, arabicIncludes, foldArabic, fuzzySearchScore, normalizeTextKey, type Category, type CatalogMatch, type CatalogMatchKind, type Item } from "@dokan/contracts";

export const DEFAULT_CATALOG_LIMIT = 20;

export interface CatalogSearchResult {
  /** the single exact-barcode hit when one exists; ui adds it immediately */
  exact: CatalogMatch | null;
  /** selectable results, ranked: partial-barcode > name > category */
  matches: CatalogMatch[];
}

/**
 * Match tiers; lower sorts first. BARCODE_EXACT never lands in `matches`
 * (it is reported through `exact`), and the two partial-barcode sub-tiers
 * collapse to the single BARCODE_PARTIAL kind in the output. FUZZY is the
 * typo-tolerance fallback: it always ranks after every strict tier.
 */
type Tier = "EXACT" | "BARCODE_PREFIX" | "BARCODE_CONTAINS" | "NAME" | "CATEGORY";

const tierRank = {
  EXACT: 0,
  BARCODE_PREFIX: 1,
  BARCODE_CONTAINS: 2,
  NAME: 3,
  CATEGORY: 4,
} satisfies Record<Tier, number>;

/** Typo-fallback rank: always one past the worst strict tier, so adding a
 * strict tier cannot let a fuzzy hit interleave with it. */
const FUZZY_RANK = Math.max(...Object.values(tierRank)) + 1;

const tierKind = {
  EXACT: "BARCODE_EXACT",
  BARCODE_PREFIX: "BARCODE_PARTIAL",
  BARCODE_CONTAINS: "BARCODE_PARTIAL",
  NAME: "NAME",
  CATEGORY: "CATEGORY",
} satisfies Record<Tier, CatalogMatchKind>;

/**
 * Catalog ranking (ticket 28): exact barcode first, then partial barcode
 * (prefix before substring), then normalized name, then category name.
 * Pure and in-memory — shop catalogs are hundreds of rows. The query is
 * matched case-insensitively against normalized keys (Arabic diacritics and
 * tatweel stripped by normalizeTextKey).
 */
export function rankCatalog(
  items: Item[],
  categories: Category[],
  rawQuery: string,
  limit: number = DEFAULT_CATALOG_LIMIT,
): CatalogSearchResult {
  const query = normalizeTextKey(rawQuery);
  if (query === "") return { exact: null, matches: [] };
  const upper = query.toUpperCase();
  const searchKey = foldArabic(rawQuery);

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const scored: Array<{ match: CatalogMatch; rank: number; score: number }> = [];
  const matchedIds = new Set<string>();
  let exact: CatalogMatch | null = null;

  for (const item of items) {
    const barcode = item.barcode?.toUpperCase() ?? null;
    let tier: Tier | null = null;
    if (barcode !== null && barcode === upper) tier = "EXACT";
    else if (barcode !== null && barcode.startsWith(upper)) tier = "BARCODE_PREFIX";
    else if (barcode !== null && barcode.includes(upper)) tier = "BARCODE_CONTAINS";
    else if (searchKey !== "" && arabicIncludes(item.name, rawQuery)) tier = "NAME";
    else {
      const category = categoryById.get(item.categoryId);
      if (category !== undefined && searchKey !== "" && arabicIncludes(category.name, rawQuery)) tier = "CATEGORY";
    }
    if (tier === null) continue;
    matchedIds.add(item.id);

    const category = categoryById.get(item.categoryId) ?? null;
    const match: CatalogMatch = { item, category, matchedBy: tierKind[tier] };
    if (tier === "EXACT") {
      // global uniqueness guarantees at most one exact hit; keep the first
      if (exact === null) exact = match;
      continue;
    }
    scored.push({ match, rank: tierRank[tier], score: 0 });
  }

  // Typo tolerance, as a fallback only: when the strict pass leaves room,
  // append edit-distance/subsequence hits AFTER every strict match. Strict
  // ranking is never altered.
  if (scored.length < limit && searchKey !== "") {
    for (const item of items) {
      if (matchedIds.has(item.id)) continue;
      const category = categoryById.get(item.categoryId) ?? null;
      const nameScore = fuzzySearchScore(item.name, rawQuery);
      const categoryScore = category === null ? 0 : fuzzySearchScore(category.name, rawQuery);
      const score = Math.max(nameScore, categoryScore);
      if (score <= FUZZY_MATCH_MIN_SCORE) continue;
      const matchedBy: CatalogMatchKind = nameScore >= categoryScore ? "NAME" : "CATEGORY";
      scored.push({ match: { item, category, matchedBy }, rank: FUZZY_RANK, score });
    }
  }

  scored.sort((a, b) => a.rank - b.rank || b.score - a.score || a.match.item.name.localeCompare(b.match.item.name, "ar"));
  return { exact, matches: scored.slice(0, limit).map((entry) => entry.match) };
}
