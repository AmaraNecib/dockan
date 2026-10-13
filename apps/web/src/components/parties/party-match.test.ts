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
    // ...nor for walk-ins with no phone on either side
    expect(duplicateNameParty("عماره", null, LIST)).toBeUndefined();
  });

  it("sees through a bidi mark pasted into the name", () => {
    expect(duplicateNameParty("علي علي\u200F", "0555123457", LIST)?.id).toBe("ali");
    // ...and through the Arabic letter mark (Greptile P1.5)
    expect(duplicateNameParty("علي علي\u061C", "0555123457", LIST)?.id).toBe("ali");
  });

  it("does not warn for an unrelated or empty name", () => {
    expect(duplicateNameParty("اسم آخر", "0555123456", LIST)).toBeUndefined();
    expect(duplicateNameParty("   ", "0555123456", LIST)).toBeUndefined();
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

  it("keeps identity matching on the unchanged strict key", () => {
    // «أحمد» and «احمد» are the SAME search hit but DIFFERENT debtors: folding
    // identity would merge two people's balances (ADR-0007).
    expect(normalizeTextKey("أحمد")).not.toBe(normalizeTextKey("احمد"));
    // no same-name warning between the two spellings...
    expect(duplicateNameParty("احمد", null, [AHMED_FOLDED])).toBeUndefined();
    expect(duplicateNameParty("أحمد", null, [AHMED_PLAIN])).toBeUndefined();
    // ...but the SAME spelling still warns and the phone identity is untouched
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
