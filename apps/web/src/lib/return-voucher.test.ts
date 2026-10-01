import { describe, expect, it } from "bun:test";

import type { ReturnDetail } from "@dokan/contracts";

import { buildReturnVoucher, debtOffsetDisplay, paginateReturnVoucher } from "./return-voucher";

const settings = { storeName: "متجر الكرامة", storePhone: "+213661234567", storeAddress: null };

function makeReturn(overrides: Partial<ReturnDetail> = {}): ReturnDetail {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    returnNumber: "RTN-0042",
    invoiceId: "00000000-0000-4000-8000-0000000000a2",
    invoiceNumber: "INV-0101",
    invoiceDate: "2026-08-26",
    counterpartyName: "يوسف",
    refundAmount: 1700,
    cashPaidOut: 1700,
    debtOffset: 0,
    debtApplied: 0,
    payoutMethod: "CASH",
    reason: "الزبون بدل رأيه",
    status: "PENDING_REVIEW",
    occurredAt: "2026-08-26T09:30:00",
    createdAt: "2026-08-26T09:30:00",
    updatedAt: "2026-08-26T09:30:00",
    lines: [
      {
        id: "00000000-0000-4000-8000-0000000000a3",
        returnId: "00000000-0000-4000-8000-0000000000a1",
        invoiceLineId: "00000000-0000-4000-8000-0000000000a4",
        itemId: "00000000-0000-4000-8000-0000000000a5",
        description: "بطارية",
        quantity: 2,
        refundUnitPrice: 850,
        refundAmount: 1700,
      },
    ],
    ...overrides,
  };
}

describe("buildReturnVoucher", () => {
  it("projects the store identity and return header verbatim", () => {
    const voucher = buildReturnVoucher(makeReturn(), settings);
    expect(voucher.storeName).toBe("متجر الكرامة");
    expect(voucher.storePhone).toBe("+213661234567");
    expect(voucher.returnNumber).toBe("RTN-0042");
    expect(voucher.invoiceNumber).toBe("INV-0101");
    expect(voucher.invoiceDate).toBe("2026-08-26");
    expect(voucher.counterpartyName).toBe("يوسف");
    expect(voucher.payoutMethod).toBe("CASH");
    expect(voucher.status).toBe("PENDING_REVIEW");
  });

  it("copies the refund total and every line snapshot without any recomputation", () => {
    const voucher = buildReturnVoucher(makeReturn(), settings);
    expect(voucher.refundAmount).toBe(1700);
    expect(voucher.lines).toHaveLength(1);
    expect(voucher.lines[0]).toEqual({
      description: "بطارية",
      quantity: 2,
      refundUnitPrice: 850,
      refundAmount: 1700,
    });
  });

  it("keeps the reason null when the record has none", () => {
    const voucher = buildReturnVoucher(makeReturn({ reason: null }), settings);
    expect(voucher.reason).toBeNull();
  });

  it("renders a rejected voucher with its review status", () => {
    const voucher = buildReturnVoucher(makeReturn({ status: "REJECTED_DAMAGED" }), settings);
    expect(voucher.status).toBe("REJECTED_DAMAGED");
  });
});

describe("debtOffsetDisplay (status-aware debt line, #68)", () => {
  it("shows the pending promise as on-acceptance", () => {
    expect(debtOffsetDisplay("PENDING_REVIEW", 400, 0)).toEqual({ labelKey: "returnsDebtOffsetPending", value: 400 });
  });

  it("shows the ACCEPTED applied amount, even when the cap applied less than promised", () => {
    expect(debtOffsetDisplay("ACCEPTED", 400, 250)).toEqual({ labelKey: "returnsDebtOffsetApplied", value: 250 });
    expect(debtOffsetDisplay("ACCEPTED", 400, 0)).toEqual({ labelKey: "returnsDebtOffsetApplied", value: 0 });
  });

  it("shows a NEW rejected return's cancelled promise as not applied", () => {
    expect(debtOffsetDisplay("REJECTED_DAMAGED", 400, 0)).toEqual({ labelKey: "returnsDebtOffsetNotApplied", value: 400 });
  });

  it("shows a LEGACY rejected row (offset applied pre-#68) as applied", () => {
    expect(debtOffsetDisplay("REJECTED_DAMAGED", 400, 400)).toEqual({ labelKey: "returnsDebtOffsetApplied", value: 400 });
  });
});

function makeReturnWithLines(count: number, description: (index: number) => string = (index) => `بطارية ${index}`): ReturnDetail {
  return makeReturn({
    lines: Array.from({ length: count }, (_, index) => ({
      id: `line-${index}`,
      returnId: "00000000-0000-4000-8000-0000000000a1",
      invoiceLineId: `invoice-line-${index}`,
      itemId: null,
      description: description(index),
      quantity: 1,
      refundUnitPrice: 100,
      refundAmount: 100,
    })),
  });
}

describe("paginateReturnVoucher (up to 200 lines, one A4 sheet per page)", () => {
  it("keeps a short voucher on one closing sheet", () => {
    const pages = paginateReturnVoucher(buildReturnVoucher(makeReturnWithLines(3), settings));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.number).toBe(1);
    expect(pages[0]?.lines).toHaveLength(3);
    expect(pages[0]?.closes).toBe(true);
  });

  it("paginates a long return so no sheet is over its budget", () => {
    const voucher = buildReturnVoucher(makeReturnWithLines(200), settings);
    const pages = paginateReturnVoucher(voucher);
    expect(pages.length).toBeGreaterThanOrEqual(18);
    expect(pages.flatMap((page) => page.lines)).toEqual(voucher.lines);
    expect(pages.map((page) => page.number)).toEqual(pages.map((_, index) => index + 1));
    expect(pages.filter((page) => page.closes)).toHaveLength(1);
    expect(pages[pages.length - 1]?.closes).toBe(true);
    // caps: first non-closing 11, later non-closing 12, closing 8
    pages.forEach((page, index) => {
      const cap = index === 0 ? (pages.length === 1 ? 7 : 11) : index === pages.length - 1 ? 8 : 12;
      const units = page.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.description.length / 32)), 0);
      expect(units).toBeLessThanOrEqual(cap);
    });
  });

  it("charges a wrapped description a second row", () => {
    const shortPages = paginateReturnVoucher(buildReturnVoucher(makeReturnWithLines(20), settings));
    const longPages = paginateReturnVoucher(
      buildReturnVoucher(makeReturnWithLines(20, (index) => `بطارية ${index} ${"x".repeat(40)}`), settings),
    );
    expect(longPages.length).toBeGreaterThan(shortPages.length);
  });
});
