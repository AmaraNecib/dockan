import { describe, expect, it } from "bun:test";

import { isPartyPhoneText, normalizePartyPhone } from "@dokan/contracts";

/**
 * Issue #129 — numeric phone identity text. A party phone is an identity key
 * (ADR-0007), so text that is not a phone must be refused before it can become
 * a "unique" identity that never matches the real number.
 *
 * The rule is numeric, NOT the Algerian-mobile shape: `normalizePartyPhone`
 * deliberately keeps a landline and a foreign number storable, so those stay
 * valid. Arabic-Indic digits are accepted and normalised to Western because the
 * owner's keyboard produces them by default (issue #108) — rejecting them would
 * lock the owner out of the primary input.
 */
describe("isPartyPhoneText — numeric identity rule (#129)", () => {
  it("accepts the Algerian mobile in every spelling the app already stores", () => {
    expect(isPartyPhoneText("0550123123")).toBe(true);
    expect(isPartyPhoneText("0550 12 34 56")).toBe(true);
    expect(isPartyPhoneText("+213550123123")).toBe(true);
    expect(isPartyPhoneText("00213550123123")).toBe(true);
    expect(isPartyPhoneText("213550123123")).toBe(true);
  });

  it("accepts a landline and a foreign number (numeric, not the mobile shape)", () => {
    expect(isPartyPhoneText("023 55 12 34")).toBe(true);
    expect(isPartyPhoneText("+33123456789")).toBe(true);
  });

  it("accepts Arabic-Indic and Extended Arabic-Indic digits and folds them to Western", () => {
    expect(isPartyPhoneText("٠٥٥٠١٢٣١٢٣")).toBe(true);
    expect(isPartyPhoneText("۰۵۶۷۶۵۴۳۲۱۰")).toBe(true);
    // the accept-and-normalise decision is pinned: Arabic-Indic is one identity
    // with its ASCII spelling
    expect(normalizePartyPhone("٠٥٥٠١٢٣١٢٣")).toBe("+213550123123");
    expect(normalizePartyPhone("٠٥٥٠١٢٣١٢٣")).toBe(normalizePartyPhone("0550123123"));
  });

  it("accepts an unset / empty / separator-only phone (optional, clears to unset)", () => {
    expect(isPartyPhoneText(null)).toBe(true);
    expect(isPartyPhoneText(undefined)).toBe(true);
    expect(isPartyPhoneText("")).toBe(true);
    expect(isPartyPhoneText("   ")).toBe(true);
    expect(isPartyPhoneText("...")).toBe(true);
    expect(isPartyPhoneText(" - ")).toBe(true);
    expect(isPartyPhoneText("\u200F")).toBe(true);
  });

  it("rejects letters, mixed text and stray symbols", () => {
    expect(isPartyPhoneText("abc")).toBe(false);
    expect(isPartyPhoneText("12a34")).toBe(false);
    expect(isPartyPhoneText("هاتف")).toBe(false);
    expect(isPartyPhoneText("0550123123x")).toBe(false);
    expect(isPartyPhoneText("12@34")).toBe(false);
    expect(isPartyPhoneText("a1b2")).toBe(false);
  });

  it("rejects a misplaced or doubled plus sign", () => {
    expect(isPartyPhoneText("+")).toBe(false);
    expect(isPartyPhoneText("++213550123123")).toBe(false);
    expect(isPartyPhoneText("12+34")).toBe(false);
    expect(isPartyPhoneText("+ 213550123123")).toBe(true); // a space after + is a separator
  });
});
