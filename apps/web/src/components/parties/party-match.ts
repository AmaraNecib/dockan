import { FUZZY_MATCH_MIN_SCORE, arabicIncludes, foldArabic, foldArabicDigits, fuzzySearchScore, normalizePartyPhone, type Party } from "@dokan/contracts";

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
 * folds the same way (#130), so a variant spelling still warns.
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
 * A likely-same party whose folded name matches the candidate's but whose phone
 * differs; the picker warns before it creates a second debtor (#130).
 *
 * Matching reuses the #165 search fold, so alef forms (`ا أ إ آ`) and ya/alef
 * maqsura (`ي ى`) spellings of one name collide: «على علي» warns against
 * «علي علي». It is exact folded equality, never edit distance, and it is a
 * WARNING only — the owner can still create the record deliberately. Identity
 * (storage, the store's unique phone, `needsChoice`) keeps `normalizeTextKey`
 * (ADR-0007); folding identity would merge two people's balances.
 *
 * A same-folded-name party with the SAME phone is the same identity —
 * `phoneMatchParty` covers that case, because the store refuses a duplicate
 * phone.
 */
export function duplicateNameParty(name: string, phone: string | null, parties: readonly PartyLike[]): PartyLike | undefined {
  const nameKey = foldArabic(name);
  if (nameKey === "") return undefined;
  const canonical = normalizePartyPhone(phone);
  return parties.find((party) => foldArabic(party.name) === nameKey && normalizePartyPhone(party.phone) !== canonical);
}

/** The party that already owns a present phone (identity when present). */
export function phoneMatchParty(phone: string | null | undefined, parties: readonly PartyLike[]): PartyLike | undefined {
  const canonical = normalizePartyPhone(phone);
  if (canonical === null) return undefined;
  return parties.find((party) => normalizePartyPhone(party.phone) === canonical);
}
