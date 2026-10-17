import { describe, expect, it } from "bun:test";

import {
  RETURN_NUMBER_PREFIX,
  documentNumberGlob,
  documentNumberSequence,
  formatDocumentNumber,
  invoiceNumberFor,
  invoiceNumberPrefixFor,
  invoiceNumberPrefixes,
  numberedDocumentSequence,
  returnNumberFor,
} from "./document-number";

/**
 * #258 — the kind lives in the number itself: INV for a sale, SUP for a supplier
 * purchase, RET for a customer return. The store formats through this module, so
 * these are the only definitions of the format.
 */
describe("document numbers (#258)", () => {
  it("gives every invoice kind its own three letters, and refuses an unknown one", () => {
    expect(invoiceNumberPrefixes).toEqual({ SALE: "INV", PURCHASE: "SUP" });
    expect(invoiceNumberPrefixFor("SALE")).toBe("INV");
    expect(invoiceNumberPrefixFor("PURCHASE")).toBe("SUP");
    expect(invoiceNumberFor("SALE", 1)).toBe("INV-0001");
    expect(invoiceNumberFor("PURCHASE", 1)).toBe("SUP-0001");
    expect(invoiceNumberFor("PURCHASE", 42)).toBe("SUP-0042");
    // a caller that casts a string past the enum must not silently mint a
    // prefix-less number
    // SAFETY: the cast is the case under test — a kind the enum does not carry
    // reaching the store through a cast, which typecheck cannot catch
    expect(() => invoiceNumberPrefixFor("REFUND" as never)).toThrow(/unknown invoice kind/u);
  });

  it("keeps four digits as a floor, not a cap", () => {
    expect(formatDocumentNumber("INV", 7)).toBe("INV-0007");
    expect(formatDocumentNumber("INV", 9999)).toBe("INV-9999");
    // %04d in SQL grows the same way; the TS formatter must not truncate
    expect(formatDocumentNumber("INV", 10_000)).toBe("INV-10000");
    expect(formatDocumentNumber("SUP", 123_456)).toBe("SUP-123456");
  });

  it("numbers customer returns RET, replacing the legacy RTN prefix", () => {
    expect(RETURN_NUMBER_PREFIX).toBe("RET");
    expect(returnNumberFor(1)).toBe("RET-0001");
    expect(returnNumberFor(6)).toBe("RET-0006");
  });

  it("reads the sequence of a legacy or a prefixed number and sorts a mixed book", () => {
    expect(documentNumberSequence("INV-0001")).toBe(1);
    expect(documentNumberSequence("SUP-0002")).toBe(2);
    expect(documentNumberSequence("RET-0007")).toBe(7);
    // a pre-#258 number that is not numeric keeps the old tolerant read
    expect(documentNumberSequence("INV-LEGACY-7")).toBe(7);
    expect(documentNumberSequence("INV-LEGACY")).toBe(0);
    // mixed old/new: the trailing number is the order, not the prefix — the
    // legacy INV-0001 still precedes the new SUP-0002 (acceptance criterion)
    const mixed = ["SUP-0003", "INV-0010", "INV-0001", "SUP-0002"];
    expect([...mixed].sort((a, b) => documentNumberSequence(a) - documentNumberSequence(b))).toEqual([
      "INV-0001",
      "SUP-0002",
      "SUP-0003",
      "INV-0010",
    ]);
  });

  it("reads a sequence only from a numbered PREFIX-NNNN document (identity readers)", () => {
    expect(numberedDocumentSequence("INV-0001")).toBe(1);
    expect(numberedDocumentSequence("SUP-0042")).toBe(42);
    // a display-only label must not win a "last number" scan on its suffix
    expect(numberedDocumentSequence("INV-RENAME-1792235400275")).toBeUndefined();
    expect(numberedDocumentSequence("INV-LEGACY")).toBeUndefined();
    expect(numberedDocumentSequence("INV-99999999999999999999")).toBeUndefined();
  });

  it("builds the GLOB that keeps a counter from reissuing an existing number", () => {
    expect(documentNumberGlob("INV")).toBe("INV-[0-9]*");
    expect(documentNumberGlob("SUP")).toBe("SUP-[0-9]*");
  });
});
