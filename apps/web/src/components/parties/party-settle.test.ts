import { describe, expect, it } from "bun:test";

import type { Invoice } from "@dokan/contracts";

import { distributePayment, settleAmountError, unpaidInvoices, unpaidTotal } from "./party-settle";

/** A minimal invoice summary; only the fields the helpers read are meaningful. */
function invoice(over: Partial<Invoice> & Pick<Invoice, "id" | "invoiceDate" | "remainingAmount">): Invoice {
  return {
    invoiceNumber: `INV-${over.id}`,
    kind: "SALE",
    counterpartyId: "party-1",
    counterpartyName: "زبون",
    subtotalAmount: over.remainingAmount,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount: over.remainingAmount,
    paidAmount: 0,
    notes: null,
    createdAt: `${over.invoiceDate}T10:00:00`,
    updatedAt: `${over.invoiceDate}T10:00:00`,
    ...over,
  };
}

describe("unpaid filter (#164)", () => {
  it("keeps only invoices with a remaining balance", () => {
    const all = [
      invoice({ id: "a", invoiceDate: "2026-09-01", remainingAmount: 100 }),
      invoice({ id: "b", invoiceDate: "2026-09-02", remainingAmount: 0 }),
      invoice({ id: "c", invoiceDate: "2026-09-03", remainingAmount: 50 }),
    ];
    expect(unpaidInvoices(all).map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(unpaidTotal(all)).toBe(150);
  });

  it("treats an empty list as no unpaid total", () => {
    expect(unpaidInvoices([])).toEqual([]);
    expect(unpaidTotal([])).toBe(0);
  });
});

describe("distribution ordering (#164)", () => {
  it("fills the oldest invoice first and caps each at its remaining", () => {
    // the api returns newest first; the plan must ignore that and go oldest first
    const invoices = [
      invoice({ id: "new", invoiceDate: "2026-09-18", remainingAmount: 20_000 }),
      invoice({ id: "old", invoiceDate: "2026-09-01", remainingAmount: 30_000 }),
    ];
    expect(distributePayment(invoices, 40_000)).toEqual([
      { invoice: invoices[1]!, applied: 30_000 },
      { invoice: invoices[0]!, applied: 10_000 },
    ]);
  });

  it("never exceeds any invoice's remaining, even when the amount is larger", () => {
    const invoices = [
      invoice({ id: "a", invoiceDate: "2026-09-01", remainingAmount: 100 }),
      invoice({ id: "b", invoiceDate: "2026-09-02", remainingAmount: 200 }),
    ];
    expect(distributePayment(invoices, 1_000)).toEqual([
      { invoice: invoices[0]!, applied: 100 },
      { invoice: invoices[1]!, applied: 200 },
    ]);
  });

  it("skips fully-paid invoices and returns them zero-applied never", () => {
    const invoices = [
      invoice({ id: "paid", invoiceDate: "2026-09-01", remainingAmount: 0 }),
      invoice({ id: "owed", invoiceDate: "2026-09-02", remainingAmount: 50 }),
    ];
    expect(distributePayment(invoices, 50)).toEqual([{ invoice: invoices[1]!, applied: 50 }]);
  });

  it("breaks a same-day tie by creation then id so the order is deterministic", () => {
    const invoices = [
      invoice({ id: "b", invoiceDate: "2026-09-01", remainingAmount: 10, createdAt: "2026-09-01T12:00:00" }),
      invoice({ id: "a", invoiceDate: "2026-09-01", remainingAmount: 10, createdAt: "2026-09-01T09:00:00" }),
      invoice({ id: "c", invoiceDate: "2026-09-01", remainingAmount: 10, createdAt: "2026-09-01T12:00:00" }),
    ];
    expect(distributePayment(invoices, 30).map((line) => line.invoice.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a same-date, same-second tie by the invoice number sequence", () => {
    // createdAt has second precision, so two invoices created in the same
    // second would otherwise fall to a random UUID: the number is the real
    // creation order (and must compare numerically, not lexically)
    const sameSecond = "2026-09-01T12:00:00";
    const invoices = [
      invoice({ id: "z", invoiceNumber: "INV-0010", invoiceDate: "2026-09-01", remainingAmount: 10, createdAt: sameSecond }),
      invoice({ id: "y", invoiceNumber: "INV-0009", invoiceDate: "2026-09-01", remainingAmount: 10, createdAt: sameSecond }),
    ];
    expect(distributePayment(invoices, 20).map((line) => line.invoice.id)).toEqual(["y", "z"]);
  });

  it("treats a zero/negative/non-finite amount as nothing applied", () => {
    const invoices = [invoice({ id: "a", invoiceDate: "2026-09-01", remainingAmount: 100 })];
    expect(distributePayment(invoices, 0)).toEqual([{ invoice: invoices[0]!, applied: 0 }]);
    expect(distributePayment(invoices, -5)).toEqual([{ invoice: invoices[0]!, applied: 0 }]);
    expect(distributePayment(invoices, Number.NaN)).toEqual([{ invoice: invoices[0]!, applied: 0 }]);
  });

  it("floors a fractional amount to whole dinars", () => {
    const invoices = [invoice({ id: "a", invoiceDate: "2026-09-01", remainingAmount: 100 })];
    expect(distributePayment(invoices, 10.9)[0]?.applied).toBe(10);
  });
});

describe("settle amount boundary (#164)", () => {
  it("accepts a whole amount within the unpaid total, including the exact total", () => {
    expect(settleAmountError("1", 1_500)).toBeNull();
    expect(settleAmountError("1500", 1_500)).toBeNull();
    expect(settleAmountError(" 900 ", 1_500)).toBeNull();
  });

  it("refuses an overpayment and unusable drafts", () => {
    expect(settleAmountError("1501", 1_500)).toBe("EXCEEDS");
    expect(settleAmountError("", 1_500)).toBe("INVALID");
    expect(settleAmountError("0", 1_500)).toBe("INVALID");
    expect(settleAmountError("-5", 1_500)).toBe("INVALID");
    expect(settleAmountError("12.5", 1_500)).toBe("INVALID");
    expect(settleAmountError("1e3", 1_500)).toBe("INVALID");
    expect(settleAmountError("abc", 1_500)).toBe("INVALID");
  });

  it("reads a grouped amount with the shared parser (#180)", () => {
    expect(settleAmountError("1 000", 1_500)).toBeNull();
    expect(settleAmountError("1,000", 1_500)).toBeNull();
    expect(settleAmountError("٢٥٠", 1_500)).toBeNull();
    // a decimal/malformed grouping is invalid, never a different number
    expect(settleAmountError("1 000,00", 1_500)).toBe("INVALID");
    expect(settleAmountError("1,5", 1_500)).toBe("INVALID");
  });
});
