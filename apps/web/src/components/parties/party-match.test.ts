import { describe, expect, it } from "bun:test";

import { normalizeTextKey } from "@dokan/contracts";

import type { PartyLike } from "./party-match";
import { duplicateNameParty, filterParties, partyQueryLooksLikePhone, phoneMatchParty } from "./party-match";

const party = (over: Partial<PartyLike> & { id: string; name: string }): PartyLike => ({
  phone: null,
  ...over,
});

const ALI = party({ id: "ali", name: "علي علي", phone: "+213555123456" });
const OMAR = party({ id: "omar", name: "عماره", phone: null });
const MOHAMED = party({ id: "mohamed", name: "محمد بنين", phone: "+213661234567" });
const LANDLINE = party({ id: "land", name: "الهاتف الثابت", phone: "023551234" });
const LIST = [ALI, OMAR, MOHAMED, LANDLINE];

describe("filterParties", () => {
  it("returns the whole list for an empty query", () => {
    expect(filterParties(LIST, "")).toEqual(LIST);
    expect(filterParties(LIST, "   ")).toEqual(LIST);
  });

  it("filters by name substring, ignoring diacritics and extra whitespace", () => {
    expect(filterParties(LIST, "علي").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "  محمد   بنين ").map((p) => p.id)).toEqual(["mohamed"]);
    // tashkeel on the query still finds the undiacritized stored name
    expect(filterParties(LIST, "مُحَمَّد").map((p) => p.id)).toEqual(["mohamed"]);
    // a bidi mark pasted into the query is stripped before matching
    expect(filterParties(LIST, "علي\u200F").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "لا يوجد")).toEqual([]);
  });

  it("filters by phone in any spelling (local digits or canonical +213)", () => {
    expect(filterParties(LIST, "0555").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "555123").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "+213 661").map((p) => p.id)).toEqual(["mohamed"]);
    // a landline matches on its national digits, separators ignored
    expect(filterParties(LIST, "0235").map((p) => p.id)).toEqual(["land"]);
    // Arabic-Indic digits from an Arabic keyboard find the ASCII-stored phone
    expect(filterParties(LIST, "٠٥٥٥١٢٣٤").map((p) => p.id)).toEqual(["ali"]);
    // a phone query never matches a party without a phone
    expect(filterParties(LIST, "0000")).toEqual([]);
  });
});

describe("partyQueryLooksLikePhone", () => {
  it("detects phone-ish input and rejects names", () => {
    expect(partyQueryLooksLikePhone("0550123123")).toBe(true);
    expect(partyQueryLooksLikePhone("+213 550 123")).toBe(true);
    expect(partyQueryLooksLikePhone("055-01")).toBe(true);
    // Arabic-Indic digits are a phone too
    expect(partyQueryLooksLikePhone("٠٥٥٠١٢٣١٢٣")).toBe(true);
    expect(partyQueryLooksLikePhone("علي")).toBe(false);
    expect(partyQueryLooksLikePhone("12")).toBe(false);
  });
});

describe("duplicateNameParty", () => {
  it("finds a same-name record whose phone differs", () => {
    expect(duplicateNameParty("علي علي", null, LIST)?.id).toBe("ali");
    expect(duplicateNameParty("علي علي", "0555123457", LIST)?.id).toBe("ali");
    expect(duplicateNameParty("عماره", "0555111222", LIST)?.id).toBe("omar");
  });

  it("does not warn when the same phone is already on the same name (same identity)", () => {
    expect(duplicateNameParty("علي علي", "0555123456", LIST)).toBeUndefined();
    // ...nor for the IDENTICAL spelling with no phone on either side: the
    // picker's `needsChoice` gate already refuses that one (#130)
    expect(duplicateNameParty("عماره", null, LIST)).toBeUndefined();
  });

  it("sees through a bidi mark pasted into the name", () => {
    expect(duplicateNameParty("علي علي\u200F", "0555123457", LIST)?.id).toBe("ali");
    // ...and through the Arabic letter mark (Greptile P1.5)
    expect(duplicateNameParty("علي علي\u061C", "0555123457", LIST)?.id).toBe("ali");
  });

  it("does not warn for an unrelated name", () => {
    expect(duplicateNameParty("اسم آخر", "0555123456", LIST)).toBeUndefined();
  });

  /**
   * #130 — the warning folds alef/ya name variants (the #165 search fold), so a
   * differently spelled record of the same person is flagged before the owner
   * creates a second debtor. Advisory only: identity stays on
   * `normalizeTextKey` (ADR-0007) and the owner can still create the record.
   */
  it("warns across alef, ya and alef-maqsura spellings of the same name", () => {
    const ALI_MAQSURA = party({ id: "ali-maqsura", name: "على علي", phone: "+213555123456" });
    const AHMED_HAMZA = party({ id: "ahmed-hamza", name: "أحمد بنين", phone: "+213555000111" });
    const MOSTAFA_MAQSURA = party({ id: "mostafa-maqsura", name: "مصطفى", phone: "+213555000222" });
    const OMAR_TA = party({ id: "omar-ta", name: "عماره", phone: "+213555000444" });
    const variants = [ALI_MAQSURA, AHMED_HAMZA, MOSTAFA_MAQSURA, OMAR_TA];

    // «على علي» vs «علي علي» — the issue's own case (ى vs ي)
    expect(duplicateNameParty("علي علي", null, variants)?.id).toBe("ali-maqsura");
    // «أحمد» vs «احمد»
    expect(duplicateNameParty("احمد بنين", null, variants)?.id).toBe("ahmed-hamza");
    // «مصطفى» vs «مصطفي»
    expect(duplicateNameParty("مصطفي", null, variants)?.id).toBe("mostafa-maqsura");
    // the reused fold also covers the ta-marbuta pair «عمارة»/«عماره»
    expect(duplicateNameParty("عمارة", null, variants)?.id).toBe("omar-ta");
    // ...tashkeel, as the strict key already did before #130
    const MOHAMED = party({ id: "mohamed", name: "محمد", phone: "+213555000777" });
    expect(duplicateNameParty("مُحَمَّد", null, [MOHAMED])?.id).toBe("mohamed");
    // ...alef inside an article-prefixed name (the article itself is kept)
    const ELASAD = party({ id: "elasad", name: "الأسد", phone: "+213555000888" });
    expect(duplicateNameParty("الاسد", null, [ELASAD])?.id).toBe("elasad");
    // ...and a separator, which the fold reads as a word break
    expect(duplicateNameParty("علي-علي", null, variants)?.id).toBe("ali-maqsura");
    // the stored spelling is reported, whatever the candidate's was
    expect(duplicateNameParty("أحمد بنين", "0555000999", variants)?.id).toBe("ahmed-hamza");
  });

  it("keeps names that differ by a real letter apart", () => {
    const variants = [
      party({ id: "ali-maqsura", name: "على علي", phone: "+213555123456" }),
      party({ id: "mahmoud", name: "محمود", phone: "+213555000333" }),
      party({ id: "mostafa", name: "مصطفى", phone: "+213555000222" }),
    ];

    // a real letter differs in each case: over-folding would merge two people
    expect(duplicateNameParty("محمد", null, variants)).toBeUndefined();
    expect(duplicateNameParty("علا علي", null, variants)).toBeUndefined();
    expect(duplicateNameParty("مصطفى نور", "0555000111", variants)).toBeUndefined();
    expect(duplicateNameParty("عماد", null, variants)).toBeUndefined();
    // a superstring or a reordered name is not the same name either
    expect(duplicateNameParty("مصطفى", null, [party({ id: "full", name: "مصطفى نور", phone: "+213555000999" })])).toBeUndefined();
    expect(duplicateNameParty("علي محمد", null, [party({ id: "order", name: "محمد علي", phone: "+213555000111" })])).toBeUndefined();
  });

  it("treats a variant spelling with the same phone as one identity, not a duplicate", () => {
    const ali = party({ id: "ali-maqsura", name: "على علي", phone: "+213555123456" });
    expect(duplicateNameParty("علي علي", "0555123456", [ali])).toBeUndefined();
    expect(duplicateNameParty("على علي", "+213555123456", [ali])).toBeUndefined();
    // the Arabic-Indic spelling of the same phone is the same identity too
    expect(duplicateNameParty("علي علي", "٠٥٥٥١٢٣٤٥٦", [ali])).toBeUndefined();
  });

  it("warns for a variant spelling even when neither side has a phone", () => {
    // the common walk-in: no phone on either side. A variant spelling is still
    // a likely second debtor — only the IDENTICAL phoneless spelling is the
    // picker's `needsChoice` case.
    const walkIn = party({ id: "walk-in", name: "علي علي", phone: null });
    expect(duplicateNameParty("على علي", null, [walkIn])?.id).toBe("walk-in");
    expect(duplicateNameParty("علي علي", null, [walkIn])).toBeUndefined();
  });

  it("prefers the exactly spelled record over an earlier variant of the name", () => {
    const variant = party({ id: "variant", name: "احمد", phone: "+213555000111" });
    const exact = party({ id: "exact", name: "أحمد", phone: "+213555000222" });
    // the warning must name the record the owner typed, in either list order,
    // because its button picks that record for her
    expect(duplicateNameParty("أحمد", "0555999999", [variant, exact])?.id).toBe("exact");
    expect(duplicateNameParty("أحمد", "0555999999", [exact, variant])?.id).toBe("exact");
  });

  it("keeps a leading «ال» significant (letters-only fold, not the search key)", () => {
    // the search fold drops «ال»; the warning must not, or two recorded family
    // names — «السعيد» and «سعيد» — would be flagged as one person
    expect(duplicateNameParty("سعيد", null, [party({ id: "elsaid", name: "السعيد", phone: "+213555000555" })])).toBeUndefined();
    expect(duplicateNameParty("الحمد", null, [party({ id: "hamd", name: "حمد", phone: "+213555000666" })])).toBeUndefined();
  });

  it("never warns for a candidate that folds to nothing", () => {
    expect(duplicateNameParty("   ", null, LIST)).toBeUndefined();
    expect(duplicateNameParty("---", null, LIST)).toBeUndefined();
    // harakat alone carry no letters: no key, so no warning
    expect(duplicateNameParty("ًّْ", null, LIST)).toBeUndefined();
    // ...and a stored party with no usable name never matches one either
    expect(duplicateNameParty("عماره", null, [party({ id: "blank", name: "---" })])).toBeUndefined();
  });
});

describe("phoneMatchParty", () => {
  it("finds the owner of a present phone in any spelling", () => {
    expect(phoneMatchParty("0555123456", LIST)?.id).toBe("ali");
    expect(phoneMatchParty("+213555123456", LIST)?.id).toBe("ali");
    expect(phoneMatchParty("0661234567", LIST)?.id).toBe("mohamed");
    expect(phoneMatchParty("023 55 12 34", LIST)?.id).toBe("land");
    // Arabic-Indic digits resolve to the same identity
    expect(phoneMatchParty("٠٥٥٥١٢٣٤٥٦", LIST)?.id).toBe("ali");
  });

  it("returns undefined for an unset or unowned phone", () => {
    expect(phoneMatchParty(null, LIST)).toBeUndefined();
    expect(phoneMatchParty("", LIST)).toBeUndefined();
    expect(phoneMatchParty("0555999999", LIST)).toBeUndefined();
  });
});

/**
 * #165 — the search fold is separate from the identity key (ADR-0007). These
 * tests pin both halves so a later refactor cannot quietly merge the two.
 */
describe("arabic search fold (#165)", () => {
  const LYOUS = party({ id: "lyous", name: "ليوز" });
  const AHMED_FOLDED = party({ id: "ahmed-alef", name: "أحمد", phone: "+213555000111" });
  const AHMED_PLAIN = party({ id: "ahmed-plain", name: "احمد" });
  const MOSTAFA = party({ id: "mostafa", name: "مصطفى" });
  const FOLD_LIST = [LYOUS, AHMED_FOLDED, AHMED_PLAIN, MOSTAFA];

  it("finds a bare name through a typed article and letter variants", () => {
    expect(filterParties(FOLD_LIST, "اليوز").map((p) => p.id)).toEqual(["lyous"]);
    expect(filterParties(FOLD_LIST, "احمد").map((p) => p.id)).toEqual(["ahmed-alef", "ahmed-plain"]);
    expect(filterParties(FOLD_LIST, "مصطفي").map((p) => p.id)).toEqual(["mostafa"]);
  });

  it("still finds a record when the typed name carries the article", () => {
    const list = [party({ id: "art", name: "البطارية" })];
    expect(filterParties(list, "بطارية").map((p) => p.id)).toEqual(["art"]);
  });

  it("keeps the identity key strict while the duplicate warning folds (#130)", () => {
    // «أحمد» and «احمد» are two identity keys: folding identity would merge two
    // people's balances (ADR-0007).
    expect(normalizeTextKey("أحمد")).not.toBe(normalizeTextKey("احمد"));
    // #130 — the ADVISORY duplicate warning folds the two spellings instead, so
    // the owner is asked before a second record splits the debtor...
    expect(duplicateNameParty("احمد", null, [AHMED_FOLDED])?.id).toBe("ahmed-alef");
    expect(duplicateNameParty("أحمد", "0555000000", [AHMED_PLAIN])?.id).toBe("ahmed-plain");
    // ...while the same spelling still warns and the phone identity is untouched
    expect(duplicateNameParty("أحمد", null, [AHMED_FOLDED])?.id).toBe("ahmed-alef");
    expect(phoneMatchParty("0555123456", LIST)?.id).toBe("ali");
  });

  it("falls back to typo tolerance only when the strict pass finds nothing", () => {
    const list = [party({ id: "battery", name: "بطارية" })];
    expect(filterParties(list, "بطلرية").map((p) => p.id)).toEqual(["battery"]);
    // the fallback never replaces a strict hit, and a phone-looking query
    // never runs the name fallback
    expect(filterParties(FOLD_LIST, "مصطفي").map((p) => p.id)).toEqual(["mostafa"]);
    expect(filterParties(list, "0000")).toEqual([]);
  });

  it("does not fall back to near-misses that are not typos", () => {
    expect(filterParties([party({ id: "oil", name: "زيوت" })], "زيت")).toEqual([]);
    expect(filterParties(FOLD_LIST, "لا يوجد")).toEqual([]);
  });

  it("does not fuzzy-match a related but different name", () => {
    expect(filterParties([party({ id: "mahmoud", name: "محمود" })], "محمد")).toEqual([]);
    expect(filterParties([party({ id: "karasi", name: "كراسي" })], "كرسي")).toEqual([]);
  });

  it("never strips a short article word into an everything-match", () => {
    // «الي» folds to «الي», so it is an ordinary (and absent) substring here
    expect(filterParties(FOLD_LIST, "الي")).toEqual([]);
  });

  it("treats a stored hyphen as a word break", () => {
    const list = [party({ id: "hyphen", name: "ليوز-زبون" })];
    expect(filterParties(list, "ليوز زبون").map((p) => p.id)).toEqual(["hyphen"]);
    expect(filterParties(list, "اليوز").map((p) => p.id)).toEqual(["hyphen"]);
  });

  it("finds an article-prefixed name from a short article-prefixed query", () => {
    // regression from Greptile round 1: «الب» used to hide «البطارية»
    expect(filterParties([party({ id: "battery", name: "البطارية" })], "الب").map((p) => p.id)).toEqual(["battery"]);
    expect(filterParties([party({ id: "phone", name: "الهاتف الثابت" })], "اله").map((p) => p.id)).toEqual(["phone"]);
  });
});
