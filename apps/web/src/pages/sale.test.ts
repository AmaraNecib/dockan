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

const { overrideInputInvalid } = await import("./sale");

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