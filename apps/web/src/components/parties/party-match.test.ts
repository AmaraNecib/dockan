import { describe, expect, it } from "bun:test";

import type { PartyLike } from "./party-match";
import { duplicateNameParty, filterParties, partyQueryLooksLikePhone, phoneMatchParty } from "./party-match";

const party = (over: Partial<PartyLike> & { id: string; name: string }): PartyLike => ({
  phone: null,
  ...over,
});

const ALI = party({ id: "ali", name: "علي علي", phone: "+213555123456" });
const OMAR = party({ id: "omar", name: "عماره", phone: null });
const MOHAMED = party({ id: "mohamed", name: "محمد بنين", phone: "+213661234567" });
const LIST = [ALI, OMAR, MOHAMED];

describe("filterParties", () => {
  it("returns the whole list for an empty query", () => {
    expect(filterParties(LIST, "")).toEqual(LIST);
    expect(filterParties(LIST, "   ")).toEqual(LIST);
  });

  it("filters by name substring, ignoring diacritics and extra whitespace", () => {
    expect(filterParties(LIST, "علي").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "  محمد   بنين ").map((p) => p.id)).toEqual(["mohamed"]);
    expect(filterParties(LIST, "لا يوجد")).toEqual([]);
  });

  it("filters by phone in any spelling (local digits or canonical +213)", () => {
    expect(filterParties(LIST, "0555").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "555123").map((p) => p.id)).toEqual(["ali"]);
    expect(filterParties(LIST, "+213 661").map((p) => p.id)).toEqual(["mohamed"]);
    // a phone query never matches a party without a phone
    expect(filterParties(LIST, "0000")).toEqual([]);
  });
});

describe("partyQueryLooksLikePhone", () => {
  it("detects phone-ish input and rejects names", () => {
    expect(partyQueryLooksLikePhone("0550123123")).toBe(true);
    expect(partyQueryLooksLikePhone("+213 550 123")).toBe(true);
    expect(partyQueryLooksLikePhone("055-01")).toBe(true);
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
  });

  it("returns undefined for an unset or unowned phone", () => {
    expect(phoneMatchParty(null, LIST)).toBeUndefined();
    expect(phoneMatchParty("", LIST)).toBeUndefined();
    expect(phoneMatchParty("0555999999", LIST)).toBeUndefined();
  });
});
