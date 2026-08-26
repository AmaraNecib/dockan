import { describe, expect, it, mock } from "bun:test";

// The page module imports the rpc client at module scope; nothing here renders,
// but the stub keeps the import graph environment-shaped like the other page
// tests (see purchase.test.tsx) without touching a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: { queryOptions: () => ({ queryKey: ["categories"], queryFn: async () => ({ items: [] }) }) },
  },
  rpcClient: {},
}));

const { overrideInputInvalid, parseQuantityDraft, quantityDraftInvalid } = await import("./sale");

describe("cart quantity draft (cleared state + deterministic parse)", () => {
  it("parses a cleared or whitespace draft to 0 (invalid, never stuck)", () => {
    expect(parseQuantityDraft("")).toBe(0);
    expect(parseQuantityDraft("   ")).toBe(0);
    expect(quantityDraftInvalid("")).toBe(true);
  });

  it("parses positive integers and rejects zero, negatives, fractions, and garbage", () => {
    expect(parseQuantityDraft("1")).toBe(1);
    expect(parseQuantityDraft("12")).toBe(12);
    expect(parseQuantityDraft(" 7 ")).toBe(7);
    expect(parseQuantityDraft("0")).toBe(0);
    expect(parseQuantityDraft("-3")).toBe(0);
    expect(parseQuantityDraft("2.5")).toBe(0);
    expect(parseQuantityDraft("abc")).toBe(0);
    expect(parseQuantityDraft("12x")).toBe(0);
    expect(quantityDraftInvalid("0")).toBe(true);
    expect(quantityDraftInvalid("2.5")).toBe(true);
  });

  it("accepts a whole multi-digit value and trims surrounding spaces", () => {
    expect(quantityDraftInvalid("42")).toBe(false);
    expect(parseQuantityDraft("0042")).toBe(42);
  });

  it("is deterministic: the same draft always resolves the same way", () => {
    for (const input of ["", "0", "1", "999", "-1", "1e3", "٥"]) {
      expect(parseQuantityDraft(input)).toBe(parseQuantityDraft(input));
    }
  });
});
describe("overrideInputInvalid (sale line price override)", () => {
  it("accepts lines without a chosen override type", () => {
    expect(overrideInputInvalid({ overrideType: "", overrideValue: "" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "", overrideValue: "900" })).toBe(false);
  });

  it("rejects an empty override value once a type is chosen (regression: Number('') === 0 would bill the line free)", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "   " })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "" })).toBe(true);
  });

  it("accepts whole nonnegative amount overrides, including an explicit zero", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "900" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "0" })).toBe(false);
  });

  it("rejects fractional, negative, or non-numeric amount overrides", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "12.5" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "-5" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "abc" })).toBe(true);
  });

  it("binds percentage overrides to whole 0-100 values", () => {
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "80" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "0" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "101" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "-1" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "12.5" })).toBe(true);
  });
});