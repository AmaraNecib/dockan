import { describe, expect, it } from "bun:test";

import { parseCashBackDraft, parseReturnQuantities } from "./supplier-return-draft";

/**
 * Regression (issue 161, Greptile finding 3): an invalid draft must be
 * REJECTED, never silently dropped. Dropping "1.5" would submit a different
 * return than the preview promised; a malformed cash-back must not become an
 * omitted refund.
 */
describe("parseReturnQuantities", () => {
  it("keeps valid lines and ignores only empty drafts", () => {
    expect(parseReturnQuantities({ a: "1", b: "", c: "2" })).toEqual({
      lines: [
        { invoiceLineId: "a", quantity: 1 },
        { invoiceLineId: "c", quantity: 2 },
      ],
    });
  });

  it("rejects the whole draft when any nonempty line is fractional", () => {
    expect(parseReturnQuantities({ a: "1", b: "1.5" })).toEqual({ error: true });
  });

  it("rejects zero, negative, and non-numeric drafts", () => {
    expect(parseReturnQuantities({ a: "0" })).toEqual({ error: true });
    expect(parseReturnQuantities({ a: "-1" })).toEqual({ error: true });
    expect(parseReturnQuantities({ a: "abc" })).toEqual({ error: true });
  });

  it("rejects an empty selection", () => {
    expect(parseReturnQuantities({})).toEqual({ error: true });
    expect(parseReturnQuantities({ a: "", b: "" })).toEqual({ error: true });
  });
});

describe("parseCashBackDraft", () => {
  it("treats empty as zero and parses a whole amount", () => {
    expect(parseCashBackDraft("")).toBe(0);
    expect(parseCashBackDraft("250")).toBe(250);
  });

  it("returns null (an error) for fractional, negative, or non-numeric drafts", () => {
    expect(parseCashBackDraft("1.5")).toBeNull();
    expect(parseCashBackDraft("-5")).toBeNull();
    expect(parseCashBackDraft("abc")).toBeNull();
  });

  it("reads a grouped cash-back draft with the shared parser (#180)", () => {
    expect(parseCashBackDraft("1 000")).toBe(1000);
    expect(parseCashBackDraft("1,000")).toBe(1000);
    expect(parseCashBackDraft("1 000,00")).toBeNull();
    expect(parseCashBackDraft("1,5")).toBeNull();
  });
});
