import { describe, expect, it } from "bun:test";

import { toArabicIndic, toExtendedArabicIndic } from "../tests/arabic-digits";
import { normalizeArabicIndicDigits, parseGroupedAmount, parseLooseNumber, parseWholeAmount, parseWholePercentage, percentageDraftInvalid } from "./amount-parse";

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
 * directional mark (RLM/LRM/ALM). The shared normalizer drops the invisible
 * pasted bidi marks before a reader trims, so the paste reads like the typed
 * value. The marks are BUILT here (never typed as an invisible literal, which
 * would be unreadable in source) because that is how the owner really gets the
 * string: the clipboard, not the keyboard.
 */
describe("bidi formatting marks in the money readers (#227)", () => {
  const RLM = "\u200f";
  const LRM = "\u200e";
  const ALM = "\u061c";
  /** The paste shape: a mark glued to the draft, front, middle or back. */
  const pasted = (mark: string, draft: string) => `${mark}${draft}`;
  /**
   * Every mark the strip drops, by name. The directional overrides LRO/RLO are
   * deliberately absent — see the boundary test below.
   */
  const STRIPPED_BIDI_MARKS: ReadonlyArray<readonly [name: string, mark: string]> = [
    ["ALM", "\u061c"],
    ["LRM", "\u200e"],
    ["RLM", "\u200f"],
    ["LRE", "\u202a"],
    ["RLE", "\u202b"],
    ["PDF", "\u202c"],
    ["LRI", "\u2066"],
    ["RLI", "\u2067"],
    ["FSI", "\u2068"],
    ["PDI", "\u2069"],
  ];

  it("normalizeArabicIndicDigits drops every pasted bidi mark, each named code point included", () => {
    // a loop over the set, not a sample: a typo'd range boundary fails here
    for (const [name, mark] of STRIPPED_BIDI_MARKS) {
      expect([name, normalizeArabicIndicDigits(`${mark}١٢٣${mark}`)]).toEqual([name, "123"]);
    }
    expect(normalizeArabicIndicDigits(pasted(RLM, "٥"))).toBe("5");
    expect(normalizeArabicIndicDigits(pasted(LRM, "١٠٠"))).toBe("100");
    expect(normalizeArabicIndicDigits(pasted(ALM, "42"))).toBe("42");
    expect(normalizeArabicIndicDigits(`${RLM}1,000${LRM}`)).toBe("1,000");
    // ASCII identity: no mark in, nothing dropped, character for character
    expect(normalizeArabicIndicDigits("123")).toBe("123");
    expect(normalizeArabicIndicDigits("1٬000")).toBe("1٬000");
    expect(normalizeArabicIndicDigits("")).toBe("");
  });

  it("leaves an invisible outside the set alone, so both strip boundaries are pinned", () => {
    // ZWSP, word-joiner and BOM are format characters but not pasted bidi marks;
    // widening the strip to the whole Cf category would start deleting these
    // and must fail. (BOM is separately dropped by `trim()`, which is ES
    // WhiteSpace — that is pre-existing, not this strip.)
    expect(normalizeArabicIndicDigits("\u200b")).toBe("\u200b");
    expect(normalizeArabicIndicDigits("\u2060")).toBe("\u2060");
    expect(normalizeArabicIndicDigits("\ufeff")).toBe("\ufeff");
    expect(parseWholeAmount("\u200b5")).toBeNull();
    expect(parseWholeAmount("\u20605")).toBeNull();
    // BOM survives the strip but `trim()` drops it (ECMAScript WhiteSpace), so
    // it reads through the pre-existing path — this strip is not what handles it
    expect(parseWholeAmount("\ufeff5")).toBe(5);
    // LRO/RLO are Bidi_Control but can display a run in forced (reversed) order,
    // so the logical characters a paste carries may differ from what the owner
    // saw. They stay: a draft carrying one is refused, never mis-read.
    expect(normalizeArabicIndicDigits("\u202d")).toBe("\u202d");
    expect(normalizeArabicIndicDigits("\u202e")).toBe("\u202e");
    expect(parseWholeAmount("\u202e123")).toBeNull();
    expect(parseWholeAmount("\u202d123")).toBeNull();
    expect(parseWholeAmount("\u202e٥")).toBeNull();
  });

  it("parseWholeAmount reads a pasted amount at either edge and is ASCII-identical", () => {
    expect(parseWholeAmount(pasted(RLM, "٥"))).toBe(5);
    expect(parseWholeAmount(pasted(LRM, "٤٢"))).toBe(42);
    expect(parseWholeAmount(pasted(ALM, "٥"))).toBe(5);
    expect(parseWholeAmount(pasted(RLM, "123"))).toBe(123);
    // a trailing mark is at least as common when copying from RTL paragraphs
    expect(parseWholeAmount(`٥${RLM}`)).toBe(5);
    expect(parseWholeAmount(`${RLM}١٢٣${LRM}`)).toBe(123);
    // an INTERIOR mark is left in place and the draft is refused, because in the
    // RTL page it reorders the digit run (`1\u200f2` renders as `21`, verified in
    // Chromium) — a refusal, never a number the owner did not see
    expect(parseWholeAmount(`1${RLM}2`)).toBeNull();
    expect(parseWholeAmount(`1${RLM}000`)).toBeNull();
    expect(parseWholeAmount(`12${ALM}3`)).toBeNull();
    expect(parseWholeAmount(`1${LRM}2`)).toBeNull();
    // the ASCII path is unchanged, and a mark-prefixed ASCII number agrees
    expect(parseWholeAmount("123")).toBe(123);
    expect(parseWholeAmount(pasted(RLM, "123"))).toBe(parseWholeAmount("123"));
    // a mark-only draft strips to "" and is still refused: the strip cannot
    // invent a number out of a bare mark
    expect(parseWholeAmount(RLM)).toBeNull();
    expect(parseWholeAmount("")).toBeNull();
    // the mark is not a digit and not a separator, so a marked decimal, sign
    // or exponent still fails on the strict reader
    expect(parseWholeAmount(pasted(RLM, "٥٫٥"))).toBeNull();
    expect(parseWholeAmount(pasted(RLM, "1e3"))).toBeNull();
    expect(parseWholeAmount(pasted(RLM, "-5"))).toBeNull();
    // an interior mark around the sign is the same refusal
    expect(parseWholeAmount(`-${RLM}5`)).toBeNull();
  });

  it("parseWholeAmount keeps the safe-integer ceiling with a pasted cap value", () => {
    expect(parseWholeAmount(pasted(RLM, "9007199254740991"))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseWholeAmount(pasted(RLM, "9007199254740992"))).toBeNull();
    expect(parseWholeAmount(pasted(RLM, "٥5"))).toBe(55); // mixed script + mark
  });

  it("parseWholePercentage reads a pasted percentage and still caps at 100", () => {
    expect(parseWholePercentage(pasted(RLM, "١٠٠"))).toBe(100);
    expect(parseWholePercentage(pasted(LRM, "٥٠"))).toBe(50);
    expect(parseWholePercentage(pasted(ALM, "100"))).toBe(100);
    expect(parseWholePercentage(pasted(RLM, "١٠١"))).toBeNull();
    expect(parseWholePercentage(pasted(RLM, "101"))).toBeNull();
    expect(parseWholePercentage(pasted(RLM, "٥٠٫٥"))).toBeNull();
    // a mark-only draft is not a percentage either
    expect(parseWholePercentage(RLM)).toBeNull();
    // and the caller-level percentage guard still refuses it (a pre-existing
    // raw-trim guard, deliberately left for the deferred «one blank predicate»
    // ticket — pinned here so the deferral is visible, not silent)
    expect(percentageDraftInvalid(RLM)).toBe(true);
    // the ASCII path is unchanged
    expect(parseWholePercentage("100")).toBe(100);
    expect(parseWholePercentage(pasted(RLM, "100"))).toBe(parseWholePercentage("100"));
  });

  it("parseGroupedAmount reads a pasted grouped amount without widening its grammar", () => {
    expect(parseGroupedAmount(pasted(RLM, "١٬٠٠٠"))).toBe(1000);
    expect(parseGroupedAmount(pasted(LRM, "1,000"))).toBe(1000);
    expect(parseGroupedAmount(pasted(LRM, "25 000"))).toBe(25000);
    // an embedded mark does not legalise a draft whose VISIBLE text is bad
    // grouping, and one inside visible-valid grouping is refused too (it would
    // reorder in the RTL page)
    expect(parseGroupedAmount(`1,${RLM}5`)).toBeNull();
    expect(parseGroupedAmount(`1,${RLM}000`)).toBeNull();
    expect(parseGroupedAmount(`1${RLM} 000`)).toBeNull();
    expect(parseGroupedAmount(pasted(RLM, "1,5"))).toBeNull();
    expect(parseGroupedAmount(pasted(RLM, "1 000,00"))).toBeNull();
    expect(parseGroupedAmount(pasted(RLM, "1,0000"))).toBeNull();
    expect(parseGroupedAmount(RLM)).toBeNull();
    expect(parseGroupedAmount("1,000")).toBe(1000);
  });

  it("parseLooseNumber keeps its Number() semantics for a pasted draft", () => {
    expect(parseLooseNumber(pasted(RLM, "٥"))).toBe(5);
    expect(parseLooseNumber(pasted(LRM, "-٥"))).toBe(-5);
    expect(parseLooseNumber(pasted(ALM, "12.5"))).toBe(12.5);
    expect(parseLooseNumber(pasted(RLM, "١e٣"))).toBe(1000);
    expect(parseLooseNumber(pasted(RLM, "0x10"))).toBe(16);
    // a mark-only draft strips to "": the loose reader's documented "" → 0,
    // pinned as a literal so a change to either side fails here
    expect(parseLooseNumber(RLM)).toBe(0);
    expect(parseLooseNumber("")).toBe(0);
    // the ASCII path is unchanged
    expect(parseLooseNumber("12.5")).toBe(12.5);
  });
});
