import { describe, expect, it } from "bun:test";

import { toArabicIndic, toExtendedArabicIndic } from "../tests/arabic-digits";
import { normalizeArabicIndicDigits } from "./amount-parse";
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
    for (const draft of ["0", "7", "0042", " 42 ", "1000000", "9007199254740993"]) {
      expect(parseWholeNumber(toArabicIndic(draft))).toBe(parseWholeNumber(draft));
      expect(parseWholeNumber(toExtendedArabicIndic(draft))).toBe(parseWholeNumber(draft));
    }
  });

  it("keeps the strict ASCII semantics (identity pin)", () => {
    // the exact forms the reader was written to refuse, plus the Arabic decimal
    // separator and an Arabic-script negative, neither of which is a digit
    for (const draft of ["", "   ", "1e3", "0x10", "12.5", "-5", "-٥", "abc", "٥٫٥"]) {
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

  it("reads an edge pasted bidi mark like the typed digit, and refuses an interior one (#227)", () => {
    // these readers inherit the shared normaliser, so the #227 edge strip applies
    // here too. The mark is BUILT, because that is how the clipboard delivers it.
    const RLM = "\u200f";
    expect(parseWholeNumber(`${RLM}٥`)).toBe(5);
    expect(parseWholeNumber(`٥${RLM}`)).toBe(5);
    expect(parseWholeNumber(`${RLM}٥${RLM}`)).toBe(5);
    // the signed reader tests `startsWith("-")` before it normalises, so an edge
    // mark in front of the sign keeps the draft unreadable — a safe refusal
    expect(parseSignedWholeNumber(`${RLM}-٥`)).toBeNull();
    expect(parseSignedWholeNumber("-٥")).toBe(-5);
    expect(resolveOpeningStock(` \u200f٧ `, false)).toEqual({ ok: true, value: 7 });
    // an interior mark can reorder the run in the RTL page, so it is refused
    expect(parseWholeNumber(`٥${RLM}٥`)).toBeNull();
    expect(parseWholeNumber(`1${RLM}000`)).toBeNull();
    // a mark-only draft is refused, never read as zero
    expect(parseWholeNumber(RLM)).toBeNull();
    expect(resolveOpeningStock(RLM, false)).toEqual({ ok: false, reason: "invalid" });
    // ASCII identity, unchanged
    expect(parseWholeNumber("123")).toBe(123);
  });

  it("judges the whole signed draft before dropping the sign, so an interior mark after `-` is refused (#227 round 2)", () => {
    const RLM = "\u200f";
    const five = `-${RLM}5`;
    // `-` is content, so the mark is INTERIOR to the signed draft and the shared
    // normaliser keeps it...
    expect(normalizeArabicIndicDigits(five)).toBe(five);
    // ...so the signed reader must judge the whole draft BEFORE it removes the
    // sign. This is the ordering pin: strip the `-` first and normalise the
    // remainder, and the now-leading mark is stripped as if it were an edge
    // mark, so `-5` falls out of an interior-mark draft and these fail.
    expect(parseSignedWholeNumber(five)).toBeNull();
    expect(parseSignedWholeNumber(`-${RLM}${toArabicIndic("5")}`)).toBeNull();
    expect(parseSignedWholeNumber(`-${RLM}${toExtendedArabicIndic("5")}`)).toBeNull();
    expect(parseSignedWholeNumber(`-${RLM}${RLM}5`)).toBeNull();
    expect(parseSignedWholeNumber(`-1${RLM}000`)).toBeNull();
  });

  it("keeps the edge, override and ASCII rules on a signed draft (#227 round 2)", () => {
    const RLM = "\u200f";
    // An edge mark is stripped at the draft edge—but a mark in FRONT of the sign
    // keeps the draft unsigned, so the shared reader refuses the `-` (the
    // round-1 pin, preserved; accepting it is a separate behaviour change).
    expect(parseSignedWholeNumber(`${RLM}-5`)).toBeNull();
    expect(parseSignedWholeNumber(`-5${RLM}`)).toBe(-5);
    expect(parseSignedWholeNumber(`${RLM}-5${RLM}`)).toBeNull();
    // the directional overrides are never dropped, edge or interior
    expect(parseSignedWholeNumber("\u202e-5")).toBeNull();
    expect(parseSignedWholeNumber("-\u202e5")).toBeNull();
    expect(parseSignedWholeNumber("\u202d-5")).toBeNull();
    // the sign path itself is unchanged: ASCII, both Arabic scripts, blank, lone sign
    expect(parseSignedWholeNumber("-5")).toBe(-5);
    expect(parseSignedWholeNumber(`-${toArabicIndic("5")}`)).toBe(-5);
    expect(parseSignedWholeNumber(`${RLM}5`)).toBe(5);
    // pre-existing: whitespace around the sign trims, so `- 5` still reads
    expect(parseSignedWholeNumber("- 5")).toBe(-5);
    expect(parseSignedWholeNumber("")).toBeNull();
    expect(parseSignedWholeNumber("   ")).toBeNull();
    expect(parseSignedWholeNumber("-")).toBeNull();
    // the safe-integer ceiling applies to the magnitude, sign or not
    expect(parseSignedWholeNumber("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
    expect(parseSignedWholeNumber("-9007199254740993")).toBeNull();
  });
});
