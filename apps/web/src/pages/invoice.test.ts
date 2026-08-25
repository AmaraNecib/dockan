import { describe, expect, it, mock } from "bun:test";

// The page module imports the rpc client at module scope; nothing here renders,
// but the stub keeps the import graph environment-shaped like the other page
// tests (see purchase.test.tsx) without touching a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesGet: { queryOptions: () => ({ queryKey: ["invoicesGet"], queryFn: async () => undefined }) },
    invoicesPay: { mutationOptions: () => ({ mutationKey: ["invoicesPay"] }) },
    invoicesList: { queryKey: () => ["invoicesList"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
  },
  rpcClient: {},
}));

const { paymentAmountError } = await import("./invoice");

describe("paymentAmountError (invoice instalment boundary)", () => {
  it("accepts an exact-remaining payment (boundary)", () => {
    expect(paymentAmountError("800", 800)).toBeNull();
    expect(paymentAmountError("1", 1)).toBeNull();
  });

  it("accepts any positive whole instalment below the remaining amount", () => {
    expect(paymentAmountError("300", 800)).toBeNull();
    expect(paymentAmountError("1", 800)).toBeNull();
  });

  it("rejects a +1 DZD overpayment with EXCEEDS", () => {
    expect(paymentAmountError("801", 800)).toBe("EXCEEDS");
    expect(paymentAmountError("900", 800)).toBe("EXCEEDS");
  });

  it("refuses any amount on a fully paid invoice", () => {
    expect(paymentAmountError("1", 0)).toBe("EXCEEDS");
  });

  it("rejects empty, zero, negative, fractional, or non-numeric input with INVALID", () => {
    expect(paymentAmountError("", 800)).toBe("INVALID");
    expect(paymentAmountError("   ", 800)).toBe("INVALID");
    expect(paymentAmountError("0", 800)).toBe("INVALID");
    expect(paymentAmountError("-5", 800)).toBe("INVALID");
    expect(paymentAmountError("12.5", 800)).toBe("INVALID");
    expect(paymentAmountError("abc", 800)).toBe("INVALID");
    expect(paymentAmountError("NaN", 800)).toBe("INVALID");
  });
});