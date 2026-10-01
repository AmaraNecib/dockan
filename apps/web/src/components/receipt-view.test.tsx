import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { Receipt, ReceiptLine } from "../lib/receipt";
import { ReceiptView } from "./receipt-view";

/**
 * Receipt printing — deterministic render of the print-only A4 invoice sheet.
 * The view is presentational (no queries, no router): with a fixed Receipt
 * fixture, the exact document that reaches the paper is asserted — the full
 * store header on every sheet, the one-line meta row, the items table, the
 * carried totals, the pinned footer with «صفحة X من Y» and the payment history.
 */

const receipt: Receipt = {
  storeName: "دكان التجربة",
  storePhone: "+213550123123",
  storeAddress: "شارع الاستقلال 12",
  invoiceNumber: "INV-0007",
  kind: "SALE",
  invoiceDate: "2026-08-25",
  counterpartyName: "زبون النقد",
  lines: [
    { description: "بطارية", quantity: 2, unitPrice: 550, netTotal: 1000 },
    { description: "تركيب", quantity: 1, unitPrice: 100, netTotal: 50 },
  ],
  subtotalAmount: 1000,
  discountAmount: 100,
  totalAmount: 950,
  paidAmount: 500,
  remainingAmount: 450,
  payments: [
    { paidAt: "2026-08-25T10:01:00", method: "CASH", amount: 300, note: "أول دفعة" },
    { paidAt: "2026-08-25T11:30:00", method: "BANK", amount: 200, note: null },
  ],
};

function line(index: number): ReceiptLine {
  return { description: `منتج ${index}`, quantity: 1, unitPrice: 100, netTotal: 100 };
}

const longReceipt: Receipt = {
  ...receipt,
  invoiceNumber: "INV-0100",
  lines: Array.from({ length: 12 }, (_, i) => line(i + 1)),
  subtotalAmount: 1200,
  discountAmount: 0,
  totalAmount: 1200,
  paidAmount: 500,
  remainingAmount: 700,
  payments: [{ paidAt: "2026-08-25T10:01:00", method: "CASH", amount: 500, note: null }],
};

let roots: Array<{ unmount: () => void }> = [];
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  host.remove();
});

function renderReceipt(data: Receipt = receipt) {
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<ReceiptView receipt={data} />);
  });
}

function text(element: Element | null = host): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sheets(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-testid="receipt-sheet"]'));
}

describe("ReceiptView — the settled A4 sheet", () => {
  it("prints the store header, one-line meta row and invoice values", () => {
    renderReceipt();
    expect(text(host.querySelector('[data-testid="receipt-store"]'))).toBe("دكان التجربة");
    expect(text(host.querySelector('[data-testid="receipt-phone"]'))).toBe("+213550123123");
    expect(text(host.querySelector('[data-testid="receipt-address"]'))).toBe("شارع الاستقلال 12");
    // the date is the app-wide shape, never the raw ISO value
    expect(text(host.querySelector('[data-testid="receipt-date"]'))).toBe("25/08/2026");
    expect(text(host.querySelector('[data-testid="receipt-number"]'))).toBe("INV-0007");
    expect(text(host.querySelector('[data-testid="receipt-party"]'))).toBe("زبون النقد");
    expect(text(host.querySelector('[data-testid="receipt-kind"]'))).toBe("فاتورة بيع");
    expect(text()).toContain("الزبون");
  });

  it("labels a purchase with المورّد and فاتورة شراء", () => {
    renderReceipt({ ...receipt, kind: "PURCHASE" });
    expect(text(host.querySelector('[data-testid="receipt-kind"]'))).toBe("فاتورة شراء");
    expect(text()).toContain("المورّد");
    expect(text()).not.toContain("فاتورة بيع");
  });

  it("shows the label with an em dash when the phone or address is missing", () => {
    renderReceipt({ ...receipt, storePhone: null, storeAddress: null });
    expect(host.querySelector('[data-testid="receipt-phone"]')).toBeNull();
    expect(host.querySelector('[data-testid="receipt-address"]')).toBeNull();
    const contacts = host.querySelector(".print-sheet-contacts");
    expect(text(contacts)).toContain("رقم الهاتف");
    expect(text(contacts)).toContain("العنوان");
    expect(text(contacts)).toContain("—");
  });

  it("titles the items table المشتريات and prints every line with grouped Western amounts", () => {
    renderReceipt();
    expect(text(host.querySelector('[data-testid="receipt-items-title"]'))).toBe("المشتريات");
    const rows = Array.from(host.querySelectorAll('[data-testid="receipt-line"]'));
    const cells = rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => text(cell)));
    expect(cells).toEqual([
      ["بطارية", "2", "550 دج", "1,000 دج"],
      ["تركيب", "1", "100 دج", "50 دج"],
    ]);
    // currency sits after the amount in the DOM: in the RTL cell that is to its left
    expect(rows[0]?.querySelector("td:last-child")?.querySelector(".print-sheet-n")?.textContent).toBe("1,000");
  });

  it("prints the totals block on the closing sheet", () => {
    renderReceipt();
    expect(text(host.querySelector('[data-testid="receipt-subtotal"]'))).toBe("1,000 دج");
    expect(text(host.querySelector('[data-testid="receipt-discount"]'))).toBe("-100 دج");
    expect(text(host.querySelector('[data-testid="receipt-total"]'))).toBe("950 دج");
    expect(text(host.querySelector('[data-testid="receipt-paid"]'))).toBe("500 دج");
    expect(text(host.querySelector('[data-testid="receipt-remaining"]'))).toBe("450 دج");
    expect(text()).toContain("مجموع المشتريات");
    expect(text()).toContain("الإجمالي");
  });

  it("prints a zero discount as 0, not a negative amount", () => {
    renderReceipt({ ...receipt, discountAmount: 0 });
    expect(text(host.querySelector('[data-testid="receipt-discount"]'))).toBe("0 دج");
  });

  it("prints the payment history with formatted timestamps and no raw T", () => {
    renderReceipt();
    const rows = Array.from(host.querySelectorAll('[data-testid="receipt-payment"]'));
    const cells = rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => text(cell)));
    expect(cells).toEqual([
      ["25/08/2026 10:01", "300 دج", "نقداً", "أول دفعة"],
      ["25/08/2026 11:30", "200 دج", "تحويل بنكي", "—"],
    ]);
    expect(text()).not.toContain("T10:01");
  });

  it("shows an empty-payments notice instead of a phantom table", () => {
    renderReceipt({ ...receipt, payments: [] });
    expect(host.querySelector('[data-testid="receipt-payments-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="receipt-payment"]')).toBeNull();
  });

  it("pins the foot of a closing one-page sheet with صفحة 1 من 1 and the invoice number", () => {
    renderReceipt();
    expect(text(host.querySelector('[data-testid="receipt-page-num"]'))).toBe("صفحة 1 من 1");
    expect(text(host.querySelector('[data-testid="receipt-ref"]'))).toBe("INV-0007");
    expect(host.querySelectorAll('[data-testid="receipt-sheet"]')).toHaveLength(1);
  });
});

describe("ReceiptView — a long invoice paginates", () => {
  it("renders one sheet per page with the full header on each", () => {
    renderReceipt(longReceipt);
    const pages = sheets();
    expect(pages).toHaveLength(2);
    // full header (store + contacts + meta) on both sheets
    for (const sheet of pages) {
      expect(text(sheet.querySelector('[data-testid="receipt-store"]'))).toBe("دكان التجربة");
      expect(text(sheet.querySelector('[data-testid="receipt-phone"]'))).toBe("+213550123123");
      expect(text(sheet.querySelector('[data-testid="receipt-number"]'))).toBe("INV-0100");
      expect(text(sheet.querySelector('[data-testid="receipt-date"]'))).toBe("25/08/2026");
    }
    const firstLines = pages[0]?.querySelectorAll('[data-testid="receipt-line"]') ?? [];
    const lastLines = pages[1]?.querySelectorAll('[data-testid="receipt-line"]') ?? [];
    expect(firstLines).toHaveLength(10);
    expect(lastLines).toHaveLength(2);
  });

  it("carries the running total off a non-closing sheet and back onto the next", () => {
    renderReceipt(longReceipt);
    const pages = sheets();
    // page 1: carried total only — never «مجموع هذه الصفحة»
    const carried = text(pages[0]?.querySelector('[data-testid="receipt-carried-total"]'));
    expect(carried).toContain("المجموع المنقول");
    expect(carried).toContain("1,000 دج");
    expect(text(pages[0])).not.toContain("مجموع هذه الصفحة");
    expect(pages[0]?.querySelector('[data-testid="receipt-total"]')).toBeNull();
    // page 2: the banner, the closing totals and the payment history
    const carryIn = text(pages[1]?.querySelector('[data-testid="receipt-carry-in"]'));
    expect(carryIn).toContain("منقول من الصفحة السابقة");
    expect(carryIn).toContain("1,000 دج");
    expect(text(pages[1]?.querySelector('[data-testid="receipt-subtotal"]'))).toBe("1,200 دج");
    expect(pages[1]?.querySelectorAll('[data-testid="receipt-payment"]')).toHaveLength(1);
  });

  it("numbers every foot against the sheet count", () => {
    renderReceipt(longReceipt);
    const pages = sheets();
    expect(text(pages[0]?.querySelector('[data-testid="receipt-page-num"]'))).toBe("صفحة 1 من 2");
    expect(text(pages[1]?.querySelector('[data-testid="receipt-page-num"]'))).toBe("صفحة 2 من 2");
    expect(text(pages[1]?.querySelector('[data-testid="receipt-ref"]'))).toBe("INV-0100");
  });

  it("shows the items title only on the first sheet", () => {
    renderReceipt(longReceipt);
    const pages = sheets();
    expect(pages[0]?.querySelector('[data-testid="receipt-items-title"]')).not.toBeNull();
    expect(pages[1]?.querySelector('[data-testid="receipt-items-title"]')).toBeNull();
  });
});

describe("ReceiptView — RTL layout tokens", () => {
  it("roots the document in rtl", () => {
    renderReceipt();
    expect(host.querySelector('[data-testid="receipt-view"]')?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the date, invoice number and phone left-to-right inside RTL", () => {
    renderReceipt();
    expect(host.querySelector('[data-testid="receipt-date"]')?.getAttribute("dir")).toBe("ltr");
    expect(host.querySelector('[data-testid="receipt-number"]')?.getAttribute("dir")).toBe("ltr");
    expect(host.querySelector('[data-testid="receipt-phone"]')?.getAttribute("dir")).toBe("ltr");
    expect(host.querySelector('[data-testid="receipt-ref"]')?.getAttribute("dir")).toBe("ltr");
  });

  it("isolates every printed amount left-to-right", () => {
    renderReceipt();
    for (const cell of host.querySelectorAll(".print-sheet-n")) {
      expect(cell.getAttribute("dir")).toBe("ltr");
    }
  });

  it("keeps the payment timestamp left-to-right inside RTL", () => {
    renderReceipt();
    const firstDateCell = host.querySelector('[data-testid="receipt-payment"] td');
    expect(firstDateCell?.getAttribute("dir")).toBe("ltr");
  });
});
