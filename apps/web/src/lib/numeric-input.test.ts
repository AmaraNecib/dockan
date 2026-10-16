import { describe, expect, it } from "bun:test";

import { toArabicIndic, toExtendedArabicIndic } from "../tests/arabic-digits";
import { parseSignedWholeNumber, parseWholeNumber, resolveOpeningStock } from "./numeric-input";

/**
 * The one opening-stock rule both item forms call (issue #125): the plain
 * create path reads blank as zero, the scan's "create with stock" path
 * requires a positive whole number, and an unreadable value is reported as
 * its own reason so each form can show its own message.
 */
describe("resolveOpeningStock (shared opening-stock rule, issue #125)", () => {
  it("reads a blank field as zero on the plain path (no opening movement)", () => {
    expect(resolveOpeningStock("", false)).toEqual({ ok: true, value: 0 });
    expect(resolveOpeningStock("   ", false)).toEqual({ ok: true, value: 0 });
  });

  it("accepts an explicit zero on the plain path", () => {
    expect(resolveOpeningStock("0", false)).toEqual({ ok: true, value: 0 });
  });

  it("requires a positive value when the path promised an opening movement", () => {
    expect(resolveOpeningStock("", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("   ", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("0", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("00", true)).toEqual({ ok: false, reason: "required" });
  });

  it("reports an unreadable value as invalid, even when a value is required", () => {
    // #225 widened the digit script: `٥` is no longer unreadable, so the pin is
    // the ASCII-only forms that stay invalid in both scripts.
    for (const bad of ["-1", "2.5", "abc", "1e3", "٥٫٥"]) {
      expect(resolveOpeningStock(bad, false)).toEqual({ ok: false, reason: "invalid" });
      expect(resolveOpeningStock(bad, true)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("accepts positive whole values on both paths and trims them", () => {
    expect(resolveOpeningStock("7", false)).toEqual({ ok: true, value: 7 });
    expect(resolveOpeningStock(" 7 ", true)).toEqual({ ok: true, value: 7 });
    expect(resolveOpeningStock("0042", true)).toEqual({ ok: true, value: 42 });
  });

  it("rejects values too large to represent exactly", () => {
    expect(resolveOpeningStock("9007199254740993", true)).toEqual({ ok: false, reason: "invalid" });
    expect(resolveOpeningStock("9007199254740993", false)).toEqual({ ok: false, reason: "invalid" });
  });
});

/**
 * #225 — the whole-number readers accept both Arabic-Indic digit scripts through
 * the one shared normaliser (`normalizeArabicIndicDigits`, #210), so an item,
 * stock, or opening-stock field reads a digit the same way the amount fields do.
 * The strict digits-only test is unchanged, so `1e3`/`0x10`/`12.5`/`""` keep the
 * exact meaning they had.
 */
describe("Arabic-Indic digits in the whole-number readers (#225)", () => {
  it("parseWholeNumber reads both Arabic scripts exactly like ASCII", () => {
    expect(parseWholeNumber("٥")).toBe(5);
    expect(parseWholeNumber("٤٢")).toBe(42);
    expect(parseWholeNumber("۵۰۰")).toBe(500);
    for (const draft of ["0", "7", "0042", " 42 ", "1000000"]) {
      expect(parseWholeNumber(toArabicIndic(draft))).toBe(parseWholeNumber(draft));
      expect(parseWholeNumber(toExtendedArabicIndic(draft))).toBe(parseWholeNumber(draft));
    }
  });

  it("keeps the strict ASCII semantics (identity pin)", () => {
    // the exact forms the reader was written to refuse, plus the Arabic decimal
    // separator, which is not a digit
    for (const draft of ["", "   ", "1e3", "0x10", "12.5", "-5", "abc", "٥٫٥"]) {
      expect(parseWholeNumber(draft)).toBeNull();
    }
  });

  it("parseSignedWholeNumber widens the digits but keeps the ASCII minus", () => {
    expect(parseSignedWholeNumber("-٥")).toBe(-5);
    expect(parseSignedWholeNumber("-۵")).toBe(-5);
    expect(parseSignedWholeNumber("٥")).toBe(5);
    expect(parseSignedWholeNumber("-42")).toBe(-42);
  });

  it("resolveOpeningStock accepts an Arabic-Indic stock draft on both paths", () => {
    expect(resolveOpeningStock("٧", false)).toEqual({ ok: true, value: 7 });
    expect(resolveOpeningStock("۷", true)).toEqual({ ok: true, value: 7 });
    // zero is still refused when the path promised an opening movement
    expect(resolveOpeningStock("۰", true)).toEqual({ ok: false, reason: "required" });
  });
});
