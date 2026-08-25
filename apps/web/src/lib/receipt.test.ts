import { describe, expect, it } from "bun:test";

import type { InvoiceDetail, Settings } from "@dokan/contracts";

import { buildReceipt } from "./receipt";

/**
 * Receipt printing — receipt projection from an invoice detail + settings.
 * The contract of the seam: copy, never recompute. A deliberately
 * inconsistent fixture proves totals pass through untouched (the receipt is a
 * print rendering of what the screen shows; it must not introduce its own
 * arithmetic that could disagree with the invoice detail).
 */

const settings: Settings = { storeName: "دكان التجربة", storePhone: "+213550123123" };

const payments: InvoiceDetail["payments"] = [
  { id: "p1", invoiceId: "inv-1", amount: 300, method: "CASH", note: "أول دفعة", paidAt: "2026-08-25T10:01:00", createdAt: "2026-08-25T10:01:00" },
  { id: "p2", invoiceId: "inv-1", amount: 200, method: "BANK", note: null, paidAt: "2026-08-25T11:30:00", createdAt: "2026-08-25T11:30:00" },
];

const invoice: InvoiceDetail = {
  id: "00000000-0000-4000-8000-000000000001",
  invoiceNumber: "INV-0007",
  kind: "SALE",
  counterpartyId: null,
  counterpartyName: "زبون النقد",
  invoiceDate: "2026-08-25",
  // intentionally odd: subtotal 1000, discount 100, total 950 — buildReceipt
  // must keep these, not "fix" them (the api computes them authoritatively)
  subtotalAmount: 1000,
  discountType: "AMOUNT",
  discountValue: 100,
  discountAmount: 100,
  totalAmount: 950,
  paidAmount: 500,
  remainingAmount: 450,
  notes: "توصيل للنهار",
  createdAt: "2026-08-25T10:00:00",
  updatedAt: "2026-08-25T10:00:00",
  lines: [
    { id: "l1", invoiceId: "inv-1", itemId: "00000000-0000-4000-8000-000000000002", description: "بطارية", quantity: 2, defaultUnitPrice: 600, unitPrice: 550, costAtSale: 400, total: 1100, discountAllocated: 100, netTotal: 1000 },
    { id: "l2", invoiceId: "inv-1", itemId: null, description: "تركيب", quantity: 1, defaultUnitPrice: 100, unitPrice: 100, costAtSale: 0, total: 100, discountAllocated: 50, netTotal: 50 },
  ],
  payments,
};

describe("buildReceipt — store identity + invoice header", () => {
  it("carries the store name and canonical phone from settings", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.storeName).toBe("دكان التجربة");
    expect(receipt.storePhone).toBe("+213550123123");
  });

  it("keeps a null store phone null (no invented placeholder)", () => {
    const receipt = buildReceipt(invoice, { storeName: "دكان", storePhone: null });
    expect(receipt.storePhone).toBeNull();
  });

  it("copies invoice number, kind, date, party and notes for the header", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.invoiceNumber).toBe("INV-0007");
    expect(receipt.kind).toBe("SALE");
    expect(receipt.invoiceDate).toBe("2026-08-25");
    expect(receipt.counterpartyName).toBe("زبون النقد");
    expect(receipt.notes).toBe("توصيل للنهار");
  });

  it("keeps an anonymous invoice's null party and null notes", () => {
    const anonymous = buildReceipt({ ...invoice, counterpartyName: null, notes: null }, settings);
    expect(anonymous.counterpartyName).toBeNull();
    expect(anonymous.notes).toBeNull();
  });
});

describe("buildReceipt — lines join in invoice order", () => {
  it("projects every line verbatim (description, quantity, unitPrice, netTotal)", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.lines).toEqual([
      { description: "بطارية", quantity: 2, unitPrice: 550, netTotal: 1000 },
      { description: "تركيب", quantity: 1, unitPrice: 100, netTotal: 50 },
    ]);
  });

  it("handles an empty lines array (no phantom rows)", () => {
    const receipt = buildReceipt({ ...invoice, lines: [] }, settings);
    expect(receipt.lines).toEqual([]);
  });
});

describe("buildReceipt — totals, paid/remaining are copied, never recomputed", () => {
  it("passes subtotal, discount and final total through unchanged", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.subtotalAmount).toBe(1000);
    expect(receipt.discountAmount).toBe(100);
    expect(receipt.totalAmount).toBe(950);
  });

  it("passes paid and remaining through unchanged", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.paidAmount).toBe(500);
    expect(receipt.remainingAmount).toBe(450);
  });

  it("reflects a fully paid invoice (remaining 0, paid == total)", () => {
    const paid = buildReceipt({ ...invoice, paidAmount: 950, remainingAmount: 0 }, settings);
    expect(paid.paidAmount).toBe(950);
    expect(paid.remainingAmount).toBe(0);
  });
});

describe("buildReceipt — payment history joins in order", () => {
  it("keeps every payment with method, amount, date and note", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.payments).toEqual([
      { paidAt: "2026-08-25T10:01:00", method: "CASH", amount: 300, note: "أول دفعة" },
      { paidAt: "2026-08-25T11:30:00", method: "BANK", amount: 200, note: null },
    ]);
  });

  it("preserves recording order when history is long and mixed", () => {
    const many: InvoiceDetail["payments"] = [
      { id: "a", invoiceId: "inv-1", amount: 1, method: "CASH", note: null, paidAt: "2026-08-25T10:00:00", createdAt: "2026-08-25T10:00:00" },
      { id: "b", invoiceId: "inv-1", amount: 2, method: "BANK", note: null, paidAt: "2026-08-25T10:05:00", createdAt: "2026-08-25T10:05:00" },
      { id: "c", invoiceId: "inv-1", amount: 3, method: "CASH", note: "أخيرة", paidAt: "2026-08-25T10:10:00", createdAt: "2026-08-25T10:10:00" },
    ];
    const receipt = buildReceipt({ ...invoice, payments: many }, settings);
    expect(receipt.payments.map((p) => p.amount)).toEqual([1, 2, 3]);
    expect(receipt.payments[2]?.note).toBe("أخيرة");
  });

  it("handles an empty payment history (no phantom rows)", () => {
    const receipt = buildReceipt({ ...invoice, payments: [] }, settings);
    expect(receipt.payments).toEqual([]);
  });
});