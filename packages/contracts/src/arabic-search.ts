/**
 * Arabic search folding (#165). Search-only: this key deliberately folds
 * variants that the identity key (`normalizeTextKey`, ADR-0007) must keep
 * apart — «أحمد» and «احمد» are the same search hit but two different debtors.
 */

/** Letter forms unified for search; the value is the canonical base letter. */
const ARABIC_LETTER_FOLDS = new Map([
  ["\u0622", "\u0627"], // آ -> ا
  ["\u0623", "\u0627"], // أ -> ا
  ["\u0625", "\u0627"], // إ -> ا
  ["\u0671", "\u0627"], // ٱ -> ا
  ["\u0672", "\u0627"], // ٲ -> ا
  ["\u0673", "\u0627"], // ٳ -> ا
  ["\u0626", "\u064A"], // ئ -> ي
  ["\u0649", "\u064A"], // ى -> ي
  ["\u0629", "\u0647"], // ة -> ه
  ["\u0624", "\u0648"], // ؤ -> و
]);

const ARABIC_LETTER_PATTERN = /[\u0622\u0623\u0624\u0625\u0626\u0629\u0649\u0671\u0672\u0673]/g;

/** The definite article stripped from a search word. */
const DEFINITE_ARTICLE = "\u0627\u0644";
/** A word only loses «ال» when at least this many letters remain; otherwise
 * `ال` + one letter would fold to a single letter that matches almost any
 * name (`الي` -> `ي`). */
const MIN_ARTICLE_STEM = 2;

/**
 * Canonical search key: NFC, lowercase, strip bidi/zero-width junk, tatweel
 * and harakat, unify alef/ya/ta-marbuta/hamza forms, treat punctuation and
 * separators as word breaks, and drop a leading definite article «ال» from
 * each word that still has at least two letters after it. That makes
 * «اليوز» fold to «يوز» (so it finds «ليوز») without folding a two-letter word
 * like «الي» into a single letter that matches almost any name.
 *
 * NOT an identity key. Identity matching keeps `normalizeTextKey` (ADR-0007).
 *
 * A short article-prefixed query keeps its «ال» (the stem guard), so this key
 * alone cannot find an article-prefixed name; use `arabicIncludes`, which also
 * tries the article-preserved form.
 */
export function foldArabic(raw: string): string {
  return dropArticles(foldLetters(raw));
}

/** Everything the fold does before the definite-article drop. Kept separate so
 * `foldArabicVariants` can expose the same text with «ال» still in place. */
function foldLetters(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    // bidi/zero-width controls pasted from Arabic-first UIs; `\s` does not
    // match them, so they must be stripped or the same name becomes two keys
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u0640\u064B-\u0652\u0670]/g, "")
    .replace(ARABIC_LETTER_PATTERN, (letter) => ARABIC_LETTER_FOLDS.get(letter) ?? letter)
    // a typed space finds a stored hyphen: «زيت-محرك» and «زيت محرك» share one key
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Drop a leading «ال» from each word that leaves at least a two-letter stem. */
function dropArticles(folded: string): string {
  return folded
    .split(" ")
    .map((word) =>
      word.length >= DEFINITE_ARTICLE.length + MIN_ARTICLE_STEM && word.startsWith(DEFINITE_ARTICLE)
        ? word.slice(DEFINITE_ARTICLE.length)
        : word,
    )
    .join(" ");
}

/**
 * Both search keys for one text: `[article-folded, article-preserved]`.
 * Matching needs both because the stem guard is asymmetric between a short
 * query and a long name: «الب» keeps its «ال» while «البطارية» drops it, so the
 * article-preserved pair is what lets the query find the name.
 */
export function foldArabicVariants(raw: string): [string, string] {
  const preserved = foldLetters(raw);
  return [dropArticles(preserved), preserved];
}

/**
 * True when `query` matches `text` under the search fold. Tries the
 * article-folded and article-preserved form of each side, so «اليوز» finds
 * «ليوز» (folded pair) and «الب» finds «البطارية» (preserved pair) without
 * weakening the short-word stem guard.
 *
 * Search only; identity matching keeps `normalizeTextKey` (ADR-0007).
 */
export function arabicIncludes(text: string, query: string): boolean {
  const queries = new Set(foldArabicVariants(query).filter((key) => key !== ""));
  if (queries.size === 0) return false;
  const texts = foldArabicVariants(text);
  for (const key of queries) {
    if (texts.some((target) => target.includes(key))) return true;
  }
  return false;
}

/**
 * Similarity floor for the typo-tolerance fallback. The comparison is strictly
 * greater than this: a candidate at exactly 0.8 is a single insert/delete
 * relative of a five-letter word (`محمد`/`محمود`, `كرسي`/`كراسي`), which are
 * different names, not typos. A `بطلرية` → `بطارية` slip scores 0.833 and
 * still qualifies; `زيت`/`زيوت` scores 0.75 and stays out.
 */
export const FUZZY_MATCH_MIN_SCORE = 0.8;

/** Two-row Levenshtein distance; keys here are short (names, not documents). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const fromA = a[i - 1] ?? "";
    for (let j = 1; j <= b.length; j++) {
      const substitution = fromA === (b[j - 1] ?? "") ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const replacement = (previous[j - 1] ?? 0) + substitution;
      current[j] = Math.min(deletion, insertion, replacement);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/**
 * Best typo-tolerance similarity of `query` against `text`, in 0..1
 * (1 = identical folded keys). Compares the folded query with the whole folded
 * text and with each of its words using normalized edit distance; an in-order
 * (subsequence) hit is the deletion-only case of that distance, so one metric
 * covers both. Returns 0 when either side folds to an empty key.
 */
export function fuzzySearchScore(text: string, query: string): number {
  const foldedQuery = foldArabic(query);
  if (foldedQuery === "") return 0;
  const foldedText = foldArabic(text);
  if (foldedText === "") return 0;
  const candidates = new Set([foldedText, ...foldedText.split(" ")]);
  let best = 0;
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const score = 1 - levenshtein(foldedQuery, candidate) / Math.max(foldedQuery.length, candidate.length);
    if (score > best) best = score;
  }
  return best;
}
