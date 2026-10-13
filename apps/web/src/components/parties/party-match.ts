import { FUZZY_MATCH_MIN_SCORE, arabicIncludes, foldArabicDigits, foldArabicVariants, fuzzySearchScore, normalizePartyPhone, normalizeTextKey, type Party } from "@dokan/contracts";

/**
 * The picker only reads identity and phone; a full Party (or a list row)
 * satisfies this. Kept structural so tests can pass plain fixtures.
 */
export type PartyLike = Pick<Party, "id" | "name" | "phone">;

/**
 * Digits the owner would recognize: a canonical +213… mobile loses its
 * country code and a local 0… loses its trunk zero, so a typed `0555` finds a
 * stored `+213555…` and a partial number still matches anywhere inside.
 * Null when nothing numeric survives (an empty query never matches all).
 */
function phoneSearchKey(raw: string | null | undefined): string | null {
  const canonical = normalizePartyPhone(raw);
  if (canonical === null) return null;
  const digits = canonical.replace(/\D/g, "");
  const national = digits.startsWith("213") ? digits.slice(3) : digits;
  const stripped = national.replace(/^0+/, "");
  return stripped === "" ? null : stripped;
}

/**
 * Filter the party list by one query: a name substring (#165 folds alef/ya
 * variants and the definite article via `arabicIncludes`, which also keeps an
 * article-preserved match so a short «الب» finds «البطارية») or a phone
 * substring compared on national digits, so a typed `0550…` finds a stored
 * `+213550…`. When the strict pass finds nothing, a typo-tolerance fallback
 * ranks edit-distance/subsequence name hits. An empty query shows the whole
 * list.
 *
 * Name matching uses the search fold; the picker's exact-name `needsChoice`
 * check stays on `normalizeTextKey` (ADR-0007). The duplicate-name warning
 * (#130) uses the letters-only half of the same fold, so a variant spelling
 * still warns while a leading «ال» stays a real difference.
 */
export function filterParties<T extends PartyLike>(parties: readonly T[], query: string): T[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...parties];
  const phoneKey = phoneSearchKey(trimmed);
  const strict = parties.filter((party) => {
    if (arabicIncludes(party.name, trimmed)) return true;
    const stored = phoneSearchKey(party.phone);
    return phoneKey !== null && stored !== null && stored.includes(phoneKey);
  });
  // Typo tolerance is a fallback: strict hits always win, and a phone-looking
  // query never falls back to name fuzzing (it would only add noise).
  if (strict.length > 0 || partyQueryLooksLikePhone(trimmed)) return strict;
  return parties
    .map((party) => ({ party, score: fuzzySearchScore(party.name, trimmed) }))
    .filter((entry) => entry.score > FUZZY_MATCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.party.name.localeCompare(b.party.name, "ar"))
    .map((entry) => entry.party);
}

/** True when a query is a phone-looking run: digits with optional `+`/separators.
 * Arabic-Indic digits fold first, so an Arabic keyboard's `٠٥٥٠` counts. */
export function partyQueryLooksLikePhone(query: string): boolean {
  const cleaned = foldArabicDigits(query).replace(/[\s.()-]/g, "");
  return /^\+?\d{3,}$/.test(cleaned);
}

/**
 * The key the picker's duplicate warning matches on (#130): the #165 letter fold
 * with the definite article KEPT — `foldArabicVariants(...)[1]`, i.e. the
 * letters-only half. Alef forms (`ا أ إ آ`) and ya/alef maqsura (`ي ى`) collide,
 * so «على علي» and «علي علي» are one key; «السعيد» and «سعيد» stay two, because
 * a leading «ال» is a real recorded difference in Algerian family names.
 *
 * Deliberately narrower than the search key `foldArabic`, which also drops «ال».
 * NOT an identity key: identity keeps `normalizeTextKey` (ADR-0007).
 */
const nameVariantKey = (name: string): string => foldArabicVariants(name)[1];

/**
 * A likely-same party the picker warns about before it creates a second debtor
 * (#130): the names fold to one key and the two records cannot be a single
 * identity. It is exact folded equality, never edit distance, and a WARNING
 * only — the owner can still create the record deliberately.
 *
 * The two records ARE one identity — so no warning — when:
 * - they share a phone (the store refuses a second owner; `phoneMatchParty`
 *   already offers that record). That record alone is skipped, so a differently
 *   spelled duplicate of it still warns, or
 * - the candidate's exact spelling is already stored with no phone: a walk-in
 *   re-typing her own name, which the picker's `needsChoice` gate already
 *   refuses. That one clears the whole list of duplicates, because the warning's
 *   one-click pick must never offer a DIFFERENT debtor than the one typed
 *   (#189 review).
 *
 * Otherwise the identical spelling is preferred over a variant of the name, so
 * the warning (and its one-click pick) points at the record the owner typed.
 *
 * Identity (storage, the store's unique phone, `needsChoice`) keeps
 * `normalizeTextKey` (ADR-0007); folding identity would merge two people's
 * balances.
 */
export function duplicateNameParty(name: string, phone: string | null, parties: readonly PartyLike[]): PartyLike | undefined {
  const foldedKey = nameVariantKey(name);
  if (foldedKey === "") return undefined;
  const strictKey = normalizeTextKey(name);
  const canonical = normalizePartyPhone(phone);
  let variant: PartyLike | undefined;
  for (const party of parties) {
    if (nameVariantKey(party.name) !== foldedKey) continue;
    const storedPhone = normalizePartyPhone(party.phone);
    if (canonical === null && storedPhone === null && normalizeTextKey(party.name) === strictKey) return undefined;
    if (canonical !== null && storedPhone === canonical) continue;
    if (normalizeTextKey(party.name) === strictKey) return party;
    variant ??= party;
  }
  return variant;
}

/** The party that already owns a present phone (identity when present). */
export function phoneMatchParty(phone: string | null | undefined, parties: readonly PartyLike[]): PartyLike | undefined {
  const canonical = normalizePartyPhone(phone);
  if (canonical === null) return undefined;
  return parties.find((party) => normalizePartyPhone(party.phone) === canonical);
}
