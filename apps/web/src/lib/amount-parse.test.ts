import { describe, expect, it } from "bun:test";

import { toArabicIndic, toExtendedArabicIndic } from "../tests/arabic-digits";
import { normalizeArabicIndicDigits, parseGroupedAmount, parseLooseNumber, parseWholeAmount, parseWholePercentage } from "./amount-parse";

/**
 * #180 — the single grouped-amount parser. Both the bulk opening-balance rows
 * and the single-entry money fields (تسوية/adjust, settle/pay/refund, invoice
 * paid-now) read amounts through `parseGroupedAmount`, so the same tricky
 * string must mean the same number everywhere.
 */
describe("parseGroupedAmount", () => {
  it("accepts plain digits and valid thousands grouping", () => {
    expect(parseGroupedAmount("1000")).toBe(1000);
    expect(parseGroupedAmount("1,000")).toBe(1000);
    expect(parseGroupedAmount("25 000")).toBe(25000);
    expect(parseGroupedAmount("1 000 000")).toBe(1_000_000);
    expect(parseGroupedAmount("1,000,000")).toBe(1_000_000);
    expect(parseGroupedAmount("٢٥٬٠٠٠")).toBe(25000);
    expect(parseGroupedAmount("۱۲۳")).toBe(123);
  });

  it("rejects a decimal or a malformed separator instead of deleting it", () => {
    expect(parseGroupedAmount("")).toBeNull();
    expect(parseGroupedAmount("   ")).toBeNull();
    expect(parseGroupedAmount("abc")).toBeNull();
    expect(parseGroupedAmount("1.5")).toBeNull();
    // the reported 100x bug: a decimal tail must not be deleted into another number
    expect(parseGroupedAmount("1 000,00")).toBeNull();
    expect(parseGroupedAmount("1,5")).toBeNull();
    // malformed grouping (wrong group width, leading/trailing separator)
    expect(parseGroupedAmount("1 00")).toBeNull();
    expect(parseGroupedAmount("1,0000")).toBeNull();
    expect(parseGroupedAmount("1000,000")).toBeNull();
    expect(parseGroupedAmount(",1000")).toBeNull();
    expect(parseGroupedAmount("1,00,0")).toBeNull();
    expect(parseGroupedAmount("1٬00")).toBeNull();
  });

  it("agrees with the strict whole reader on every plain-draft input", () => {
    // a digits-only draft is the one place the two readers overlap; they must
    // never disagree there, and the grouped reader is a superset of the strict
    // one for valid grouping.
    for (const draft of ["0", "7", "1000", "123456", " 42 "]) {
      expect(parseGroupedAmount(draft)).toBe(parseWholeAmount(draft));
    }
    for (const draft of ["", "   ", "abc", "1.5", "-5", "1e3"]) {
      expect(parseGroupedAmount(draft)).toBeNull();
      expect(parseWholeAmount(draft)).toBeNull();
    }
  });

  it("keeps the percentage reader strict (a percentage is never grouped)", () => {
    expect(parseWholePercentage("100")).toBe(100);
    expect(parseWholePercentage("1 000")).toBeNull();
    expect(parseWholePercentage("1,000")).toBeNull();
  });

  it("rejects overflow and mixed-script malformed grouping", () => {
    // beyond Number.MAX_SAFE_INTEGER: parseWholeAmount's guard rejects it
    expect(parseGroupedAmount("99999999999999999999")).toBeNull();
    // mixed Latin + Arabic thousands separator with a bad group width
    expect(parseGroupedAmount("1٬00")).toBeNull();
    expect(parseGroupedAmount("١٬٠٠")).toBeNull();
    // a valid mixed-script grouped amount still parses
    expect(parseGroupedAmount("1٬000")).toBe(1000);
  });
});

/**
 * #198 — the one digit normalizer, shared by the amount reader and the quantity
 * reader so a digit one accepts the other cannot reject.
 */
describe("normalizeArabicIndicDigits", () => {
  it("maps both Arabic digit ranges to ASCII and leaves everything else alone", () => {
    expect(normalizeArabicIndicDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeArabicIndicDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeArabicIndicDigits("٤٢")).toBe("42");
    expect(normalizeArabicIndicDigits("1٬000")).toBe("1٬000");
    expect(normalizeArabicIndicDigits("abc 5")).toBe("abc 5");
    expect(normalizeArabicIndicDigits("")).toBe("");
  });
});

/**
 * #210 — the money readers accept Arabic-Indic and Extended Arabic-Indic digits
 * too, through the same normalizer. The value an ASCII draft reads must not
 * move; only the digit script does.
 */
describe("Arabic-Indic digits in the money readers (#210)", () => {
  it("parseWholeAmount reads both Arabic scripts exactly like ASCII", () => {
    expect(parseWholeAmount("٥")).toBe(5);
    expect(parseWholeAmount("٤٢")).toBe(42);
    expect(parseWholeAmount("۰")).toBe(0);
    expect(parseWholeAmount("۵۰۰")).toBe(500);
    for (const draft of ["0", "5", "42", "900"]) {
      expect(parseWholeAmount(toArabicIndic(draft))).toBe(parseWholeAmount(draft));
      expect(parseWholeAmount(toExtendedArabicIndic(draft))).toBe(parseWholeAmount(draft));
    }
    // the ASCII values #198 left in place are unchanged
    expect(parseWholeAmount("42")).toBe(42);
    expect(parseWholeAmount(" 42 ")).toBe(42);
    expect(parseWholeAmount("")).toBeNull();
    expect(parseWholeAmount("1e3")).toBeNull();
    // the Arabic decimal separator is NOT a digit: a decimal still fails
    expect(parseWholeAmount("٥٫٥")).toBeNull();
    expect(parseWholeAmount("١٢.٥")).toBeNull();
    expect(parseWholeAmount("abc")).toBeNull();
  });

  it("parseWholePercentage reads both Arabic scripts and still caps at 100", () => {
    expect(parseWholePercentage("٥٠")).toBe(50);
    expect(parseWholePercentage("١٠٠")).toBe(100);
    expect(parseWholePercentage("۱۰۰")).toBe(100);
    expect(parseWholePercentage("١٠١")).toBeNull();
    expect(parseWholePercentage("۱۰۱")).toBeNull();
    expect(parseWholePercentage("١٢.٥")).toBeNull();
    for (const draft of ["0", "10", "50", "100"]) {
      expect(parseWholePercentage(toArabicIndic(draft))).toBe(parseWholePercentage(draft));
      expect(parseWholePercentage(toExtendedArabicIndic(draft))).toBe(parseWholePercentage(draft));
    }
    expect(parseWholePercentage("50")).toBe(50); // ASCII unchanged
  });

  it("parseLooseNumber keeps the loose Number read and only maps digits", () => {
    expect(parseLooseNumber("٥")).toBe(5);
    expect(parseLooseNumber("٩٠٠")).toBe(900);
    expect(parseLooseNumber("۵۰")).toBe(50);
    // the ASCII behaviour is the raw Number() it replaces, unchanged
    expect(parseLooseNumber("1e3")).toBe(1000);
    expect(parseLooseNumber("0x10")).toBe(16);
    expect(parseLooseNumber("12.5")).toBe(12.5);
    expect(parseLooseNumber("")).toBe(0);
    expect(Number.isNaN(parseLooseNumber("abc"))).toBe(true);
    expect(Number.isNaN(parseLooseNumber("٥٫٥"))).toBe(true);
    // Number trims, so a padded draft still reads; the ASCII twin does too
    expect(parseLooseNumber(" ٥٠ ")).toBe(50);
    expect(parseLooseNumber(" ٥٠ ")).toBe(parseLooseNumber(" 50 "));
    expect(parseLooseNumber("٠")).toBe(0);
    expect(parseLooseNumber("-٥")).toBe(-5);
    // normalising digits first lets an Arabic digit compose an ASCII numeric
    // grammar (`1e3`, `0x10`); the loose reader is defined as Number() after a
    // digit-only replace, so these read like their ASCII twins. The strict
    // readers still reject both.
    expect(parseLooseNumber("١e٣")).toBe(1000);
    expect(parseLooseNumber("١e٣")).toBe(parseLooseNumber("1e3"));
    expect(parseLooseNumber("٠x١٠")).toBe(16);
    expect(parseWholeAmount("١e٣")).toBeNull();
  });

  it("normalises each digit independently, so a mixed-script draft concatenates (#210)", () => {
    // the normalizer is per-character: «٥5» is two digits, not one. Pinned so a
    // mixed paste has a stated meaning instead of an accidental one.
    expect(parseWholeAmount("٥5")).toBe(55);
    expect(parseWholeAmount("٥5")).toBe(parseWholeAmount("55"));
    expect(parseWholeAmount("٥۵")).toBe(55);
  });

  it("keeps the strict readers' safe-integer ceiling in either script (#210)", () => {
    expect(parseWholeAmount("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseWholeAmount(toArabicIndic("9007199254740991"))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseWholeAmount(toArabicIndic("9007199254740992"))).toBeNull();
  });
});

/**
 * #227 — a number copied out of RTL text commonly carries an invisible
 * directional mark (RLM/LRM/ALM). The shared normalizer drops the Unicode
 * `Bidi_Control` set before a reader trims, so the paste reads like the typed
 * value. The marks are BUILT here (never typed as an invisible literal, which
 * would be unreadable in source) because that is how the owner really gets the
 * string: the clipboard, not the keyboard.
 */
describe("bidi formatting marks in the money readers (#227)", () => {
  const RLM = "\u200f";
  const LRM = "\u200e";
  const ALM = "\u061c";
  const RLE = "\u202b";
  const PDF = "\u202c";
  const LRI = "\u2066";
  const PDI = "\u2069";
  /** The paste shape: a mark glued to the front of the digit string. */
  const pasted = (mark: string, draft: string) => `${mark}${draft}`;

  it("normalizeArabicIndicDigits drops every Bidi_Control mark and leaves a mark-free draft alone", () => {
    expect(normalizeArabicIndicDigits(pasted(RLM, "٥"))).toBe("5");
    expect(normalizeArabicIndicDigits(pasted(LRM, "١٠٠"))).toBe("100");
    expect(normalizeArabicIndicDigits(pasted(ALM, "42"))).toBe("42");
    expect(normalizeArabicIndicDigits(`${RLE}١٢٣${PDF}`)).toBe("123");
    expect(normalizeArabicIndicDigits(`${LRI}١٢٣${PDI}`)).toBe("123");
    expect(normalizeArabicIndicDigits(`${RLM}1,000${LRM}`)).toBe("1,000");
    // ASCII identity: no mark in, nothing dropped, character for character
    expect(normalizeArabicIndicDigits("123")).toBe("123");
    expect(normalizeArabicIndicDigits("1٬000")).toBe("1٬000");
    expect(normalizeArabicIndicDigits("")).toBe("");
  });

  it("parseWholeAmount reads a pasted Arabic-Indic amount and is ASCII-identical without a mark", () => {
    expect(parseWholeAmount(pasted(RLM, "٥"))).toBe(5);
    expect(parseWholeAmount(pasted(LRM, "٤٢"))).toBe(42);
    expect(parseWholeAmount(pasted(ALM, "٥"))).toBe(5);
    // the ASCII path is unchanged, and a mark-prefixed ASCII number now agrees
    // with the bare one instead of being refused
    expect(parseWholeAmount("123")).toBe(123);
    expect(parseWholeAmount(pasted(RLM, "123"))).toBe(123);
    expect(parseWholeAmount(pasted(RLM, "123"))).toBe(parseWholeAmount("123"));
    expect(parseWholeAmount(pasted(RLM, "123"))).toBe(parseWholeAmount(pasted(LRM, "123")));
    // a mark-only draft strips to "" and is still refused: the strip cannot
    // invent a number out of a bare mark
    expect(parseWholeAmount(RLM)).toBeNull();
    expect(parseWholeAmount("")).toBeNull();
    // the mark is not a digit and not a separator, so a marked decimal still fails
    expect(parseWholeAmount(pasted(RLM, "٥٫٥"))).toBeNull();
    expect(parseWholeAmount(pasted(RLM, "1e3"))).toBeNull();
  });

  it("parseWholePercentage reads a pasted percentage and still caps at 100", () => {
    expect(parseWholePercentage(pasted(RLM, "١٠٠"))).toBe(100);
    expect(parseWholePercentage(pasted(LRM, "٥٠"))).toBe(50);
    expect(parseWholePercentage(pasted(ALM, "100"))).toBe(100);
    expect(parseWholePercentage(pasted(RLM, "١٠١"))).toBeNull();
    // the ASCII path is unchanged
    expect(parseWholePercentage("100")).toBe(100);
    expect(parseWholePercentage(pasted(RLM, "100"))).toBe(parseWholePercentage("100"));
  });

  it("parseGroupedAmount reads a pasted grouped amount without widening its grammar", () => {
    expect(parseGroupedAmount(pasted(RLM, "١٬٠٠٠"))).toBe(1000);
    expect(parseGroupedAmount(pasted(LRM, "1,000"))).toBe(1000);
    expect(parseGroupedAmount(pasted(LRM, "25 000"))).toBe(25000);
    // stripping a mark cannot legalise grouping the reader rejects
    expect(parseGroupedAmount(pasted(RLM, "1,5"))).toBeNull();
    expect(parseGroupedAmount(pasted(RLM, "1 000,00"))).toBeNull();
    expect(parseGroupedAmount(pasted(RLM, "1,0000"))).toBeNull();
    expect(parseGroupedAmount("1,000")).toBe(1000);
  });

  it("parseLooseNumber keeps its Number() semantics for a pasted draft", () => {
    expect(parseLooseNumber(pasted(RLM, "٥"))).toBe(5);
    expect(parseLooseNumber(pasted(LRM, "-٥"))).toBe(-5);
    expect(parseLooseNumber(pasted(ALM, "12.5"))).toBe(12.5);
    expect(parseLooseNumber(pasted(RLM, "١e٣"))).toBe(1000);
    // a mark-only draft strips to "": the loose reader's documented "" → 0
    expect(parseLooseNumber(RLM)).toBe(parseLooseNumber(""));
    // the ASCII path is unchanged
    expect(parseLooseNumber("12.5")).toBe(12.5);
  });
});
