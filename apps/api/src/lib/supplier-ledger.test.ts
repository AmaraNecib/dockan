import { describe, expect, it } from "bun:test";

import {
  allocateOldestFirst,
  deriveInvoicePaid,
  splitAgainstRemaining,
  supplierBalance,
  supplierEntrySign,
  supplierReturnSplit,
  type AllocatableInvoice,
} from "./supplier-ledger";

describe("supplierEntrySign", () => {
  it("charges purchases and refunds, credits payments and returns", () => {
    expect(supplierEntrySign("PURCHASE")).toBe(1);
    expect(supplierEntrySign("REFUND")).toBe(1);
    expect(supplierEntrySign("PAYMENT")).toBe(-1);
    expect(supplierEntrySign("RETURN")).toBe(-1);
  });
});

describe("supplierBalance", () => {
  it("sums the signed account: positive = the shop owes the supplier", () => {
    const entries = [
      { kind: "PURCHASE" as const, amount: 1000 },
      { kind: "PAYMENT" as const, amount: 400 },
      { kind: "RETURN" as const, amount: 100 },
      { kind: "REFUND" as const, amount: 50 },
    ];
    expect(supplierBalance(entries)).toBe(1000 - 400 - 100 + 50);
  });

  it("goes negative when the shop is ahead (a credit)", () => {
    expect(supplierBalance([
      { kind: "PURCHASE" as const, amount: 100 },
      { kind: "PAYMENT" as const, amount: 250 },
    ])).toBe(-150);
  });

  it("is zero for an empty account", () => {
    expect(supplierBalance([])).toBe(0);
  });
});

describe("splitAgainstRemaining", () => {
  it("attaches what fits and turns the excess into credit", () => {
    expect(splitAgainstRemaining(300, 500)).toEqual({ attached: 300, credit: 0 });
    expect(splitAgainstRemaining(500, 300)).toEqual({ attached: 300, credit: 200 });
  });

  it("keeps the whole amount as credit when nothing is owed", () => {
    expect(splitAgainstRemaining(120, 0)).toEqual({ attached: 0, credit: 120 });
  });
});

describe("deriveInvoicePaid", () => {
  it("sums only the negative entries that name the invoice, capped at the total", () => {
    const entries = [
      { kind: "PURCHASE" as const, amount: 1000, invoiceId: "inv-1" },
      { kind: "PAYMENT" as const, amount: 300, invoiceId: "inv-1" },
      { kind: "RETURN" as const, amount: 200, invoiceId: "inv-1" },
      // a credit payment names no invoice and must not touch this one
      { kind: "PAYMENT" as const, amount: 999, invoiceId: null },
      // another invoice's payment is not this invoice's
      { kind: "PAYMENT" as const, amount: 500, invoiceId: "inv-2" },
    ];
    expect(deriveInvoicePaid(entries, "inv-1", 1000)).toBe(500);
  });

  it("never exceeds the invoice total even if corrupt entries would", () => {
    const entries = [
      { kind: "PAYMENT" as const, amount: 800, invoiceId: "inv-1" },
      { kind: "PAYMENT" as const, amount: 800, invoiceId: "inv-1" },
    ];
    expect(deriveInvoicePaid(entries, "inv-1", 1000)).toBe(1000);
  });

  it("is zero for an invoice with no entries", () => {
    expect(deriveInvoicePaid([], "inv-1", 1000)).toBe(0);
  });
});

const invoice = (over: Partial<AllocatableInvoice> & Pick<AllocatableInvoice, "id">): AllocatableInvoice => ({
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  invoiceNumber: "INV-0001",
  remainingAmount: 100,
  ...over,
});

describe("allocateOldestFirst", () => {
  it("fills the oldest invoice first and stops when the amount runs out", () => {
    const invoices = [
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 400 }),
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 300 }),
    ];
    const plan = allocateOldestFirst(invoices, 500);
    expect(plan.map((line) => [line.invoice.id, line.applied])).toEqual([
      ["a", 300],
      ["b", 200],
    ]);
  });

  it("caps each invoice at its remaining and leaves the tail undistributed", () => {
    const invoices = [
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 100 }),
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 100 }),
    ];
    const plan = allocateOldestFirst(invoices, 250);
    expect(plan.reduce((sum, line) => sum + line.applied, 0)).toBe(200);
  });

  it("ignores settled invoices", () => {
    const invoices = [
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 0 }),
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 100 }),
    ];
    const plan = allocateOldestFirst(invoices, 50);
    expect(plan.map((line) => line.invoice.id)).toEqual(["b"]);
    expect(plan[0]?.applied).toBe(50);
  });

  it("breaks same-date ties by creation then invoice number", () => {
    const invoices = [
      invoice({ id: "c", invoiceDate: "2026-01-01", createdAt: "2026-01-01T12:00:00", invoiceNumber: "INV-0003", remainingAmount: 10 }),
      invoice({ id: "a", invoiceDate: "2026-01-01", createdAt: "2026-01-01T09:00:00", invoiceNumber: "INV-0001", remainingAmount: 10 }),
      invoice({ id: "b", invoiceDate: "2026-01-01", createdAt: "2026-01-01T09:00:00", invoiceNumber: "INV-0002", remainingAmount: 10 }),
    ];
    expect(allocateOldestFirst(invoices, 30).map((line) => line.invoice.id)).toEqual(["a", "b", "c"]);
  });

  it("allocates nothing for a non-positive or non-finite amount", () => {
    const invoices = [invoice({ id: "a", remainingAmount: 100 })];
    expect(allocateOldestFirst(invoices, 0).every((line) => line.applied === 0)).toBe(true);
    expect(allocateOldestFirst(invoices, Number.NaN).every((line) => line.applied === 0)).toBe(true);
  });
});

describe("supplierReturnSplit", () => {
  it("reduces the invoice debt up to its remaining, the rest is credit", () => {
    expect(supplierReturnSplit(400, 250)).toEqual({ debtReduction: 250, credit: 150 });
  });

  it("is all credit when no invoice is named", () => {
    expect(supplierReturnSplit(400, null)).toEqual({ debtReduction: 0, credit: 400 });
  });

  it("is all credit when the named invoice is already settled", () => {
    expect(supplierReturnSplit(400, 0)).toEqual({ debtReduction: 0, credit: 400 });
  });
});
