import { describe, expect, it } from "bun:test";

import type { InvoiceDetail, Settings } from "@dokan/contracts";

import { buildReceipt, paginateReceipt, type Receipt, type ReceiptLine } from "./receipt";

/**
 * Receipt printing — receipt projection from an invoice detail + settings.
 * The contract of the seam: copy, never recompute. A deliberately
 * inconsistent fixture proves totals pass through untouched (the receipt is a
 * print rendering of what the screen shows; it must not introduce its own
 * arithmetic that could disagree with the invoice detail).
 */

const settings: Settings = { storeName: "دكان التجربة", storePhone: "+213550123123", storeAddress: "شارع الاستقلال 12" };

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
    { id: "l1", invoiceId: "inv-1", itemId: "00000000-0000-4000-8000-000000000002", description: "بطارية", quantity: 2, defaultUnitPrice: 600, unitPrice: 550, costAtSale: 400, cogsExact: 800, total: 1100, discountAllocated: 100, netTotal: 1000 },
    { id: "l2", invoiceId: "inv-1", itemId: null, description: "تركيب", quantity: 1, defaultUnitPrice: 100, unitPrice: 100, costAtSale: 0, cogsExact: 0, total: 100, discountAllocated: 50, netTotal: 50 },
  ],
  payments,
};

describe("buildReceipt — store identity + invoice header", () => {
  it("carries the store name, canonical phone and address from settings", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.storeName).toBe("دكان التجربة");
    expect(receipt.storePhone).toBe("+213550123123");
    expect(receipt.storeAddress).toBe("شارع الاستقلال 12");
  });

  it("keeps a null store phone/address null (no invented placeholder)", () => {
    const receipt = buildReceipt(invoice, { storeName: "دكان", storePhone: null, storeAddress: null });
    expect(receipt.storePhone).toBeNull();
    expect(receipt.storeAddress).toBeNull();
  });

  it("copies invoice number, kind, dates and party for the header", () => {
    const receipt = buildReceipt(invoice, settings);
    expect(receipt.invoiceNumber).toBe("INV-0007");
    expect(receipt.kind).toBe("SALE");
    expect(receipt.invoiceDate).toBe("2026-08-25");
    // «التاريخ والوقت» prints the recording timestamp, not the date-only field
    expect(receipt.invoiceCreatedAt).toBe("2026-08-25T10:00:00");
    expect(receipt.counterpartyName).toBe("زبون النقد");
  });

  it("keeps an anonymous invoice's null party", () => {
    const anonymous = buildReceipt({ ...invoice, counterpartyName: null }, settings);
    expect(anonymous.counterpartyName).toBeNull();
  });
});

describe("buildReceipt — notes never reach the paper", () => {
  it("drops the invoice notes from the projection (owner decision)", () => {
    // the source invoice still has them; the print seam must not carry them
    expect(invoice.notes).toBe("توصيل للنهار");
    const receipt = buildReceipt(invoice, settings);
    expect("notes" in receipt).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("توصيل للنهار");
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

// --- pagination -----------------------------------------------------------

function line(index: number, over: Partial<ReceiptLine> = {}): ReceiptLine {
  return { description: `منتج ${index}`, quantity: 1, unitPrice: 100, netTotal: 100 + index, ...over };
}

function receiptWith(lines: ReceiptLine[], paymentCount = 0): Receipt {
  return {
    storeName: "دكان التجربة",
    storePhone: "+213550123123",
    storeAddress: null,
    invoiceNumber: "INV-0042",
    kind: "SALE",
    invoiceDate: "2026-10-01",
    invoiceCreatedAt: "2026-10-01T09:30:00",
    counterpartyName: "علي",
    lines,
    subtotalAmount: lines.reduce((sum, l) => sum + l.netTotal, 0),
    discountAmount: 0,
    totalAmount: lines.reduce((sum, l) => sum + l.netTotal, 0),
    paidAmount: 0,
    remainingAmount: lines.reduce((sum, l) => sum + l.netTotal, 0),
    payments: Array.from({ length: paymentCount }, (_, i) => ({
      paidAt: `2026-10-0${(i % 9) + 1}T09:0${i}:00`,
      method: "CASH" as const,
      amount: 100,
      note: null,
    })),
  };
}

const linesOf = (pages: ReturnType<typeof paginateReceipt>) => pages.flatMap((page) => page.lines);

describe("paginateReceipt — one A4 sheet per page", () => {
  it("keeps a short invoice on one sheet that closes", () => {
    const pages = paginateReceipt(receiptWith([line(1), line(2), line(3)]));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.number).toBe(1);
    expect(pages[0]?.lines).toHaveLength(3);
    expect(pages[0]?.carryIn).toBe(0);
    expect(pages[0]?.carryOut).toBeNull();
    expect(pages[0]?.closes).toBe(true);
  });

  it("keeps a 5-line no-payment invoice on one sheet (no payment head reserved)", () => {
    const lines = Array.from({ length: 5 }, (_, i) => line(i + 1));
    const pages = paginateReceipt(receiptWith(lines));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.lines).toHaveLength(5);
    expect(pages[0]?.closes).toBe(true);
    expect(pages[0]?.payments).toEqual([]);
  });

  it("splits exactly at the one-sheet boundary: 7 lines fit, 8 need a second sheet", () => {
    expect(paginateReceipt(receiptWith(Array.from({ length: 7 }, (_, i) => line(i + 1))))).toHaveLength(1);
    const eight = paginateReceipt(receiptWith(Array.from({ length: 8 }, (_, i) => line(i + 1))));
    expect(eight).toHaveLength(2);
    expect(eight[0]?.lines).toHaveLength(4);
    expect(eight[1]?.lines).toHaveLength(4);
  });

  it("balances exactly 10 lines across two sheets (5/5), none dropped", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1));
    const pages = paginateReceipt(receiptWith(lines));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.lines).toHaveLength(5);
    expect(pages[1]?.lines).toHaveLength(5);
    expect(linesOf(pages)).toEqual(lines);
  });

  it("paginates a long invoice into sheets that each close or carry a running total", () => {
    const lines = Array.from({ length: 13 }, (_, i) => line(i + 1));
    const pages = paginateReceipt(receiptWith(lines));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.lines).toHaveLength(7);
    expect(pages[1]?.lines).toHaveLength(6);
    // every line printed exactly once, in order
    expect(linesOf(pages)).toEqual(lines);
    // page 1 carries the running total of its own lines; page 2 closes
    expect(pages[0]?.closes).toBe(false);
    expect(pages[0]?.carryIn).toBe(0);
    expect(pages[0]?.carryOut).toBe(sum(pages[0]?.lines ?? []));
    expect(pages[1]?.carryIn).toBe(sum(pages[0]?.lines ?? []));
    expect(pages[1]?.carryOut).toBeNull();
    expect(pages[1]?.closes).toBe(true);
  });

  it("keeps the settled 12-line split at 10/2 when a payment shares the closing sheet", () => {
    const lines = Array.from({ length: 12 }, (_, i) => line(i + 1));
    const pages = paginateReceipt(receiptWith(lines, 1));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.lines).toHaveLength(10);
    expect(pages[1]?.lines).toHaveLength(2);
    expect(pages[1]?.payments).toHaveLength(1);
    expect(pages[0]?.payments).toHaveLength(0);
  });

  it("spreads a 20-line invoice over three sheets", () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(i + 1));
    const pages = paginateReceipt(receiptWith(lines));
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.lines.length)).toEqual([7, 7, 6]);
    expect(pages.map((page) => page.closes)).toEqual([false, false, true]);
  });

  it("moves a long payment history onto continuation sheets with no lines", () => {
    const pages = paginateReceipt(receiptWith([line(1)], 26));
    const closingIndex = pages.findIndex((page) => page.closes);
    const continuation = pages.slice(closingIndex + 1);
    expect(continuation.length).toBeGreaterThan(0);
    for (const page of continuation) {
      expect(page.lines).toEqual([]);
      expect(page.closes).toBe(false);
    }
    expect(pages.flatMap((page) => page.payments)).toHaveLength(26);
  });

  it("charges a wrapping description a second row", () => {
    const short = Array.from({ length: 13 }, (_, i) => line(i + 1));
    // a description long enough to wrap doubles each line's weight, so the
    // same 13 lines need more sheets than the one-row-per-line case
    const long = short.map((l) => ({ ...l, description: "ا".repeat(40) }));
    expect(paginateReceipt(receiptWith(short))).toHaveLength(2);
    expect(paginateReceipt(receiptWith(long))).toHaveLength(4);
  });

  it("still returns one closing sheet for an invoice with no lines", () => {
    const pages = paginateReceipt(receiptWith([], 1));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.lines).toEqual([]);
    expect(pages[0]?.closes).toBe(true);
    expect(pages[0]?.payments).toHaveLength(1);
  });
});

function sum(lines: readonly ReceiptLine[]): number {
  return lines.reduce((total, l) => total + l.netTotal, 0);
}
