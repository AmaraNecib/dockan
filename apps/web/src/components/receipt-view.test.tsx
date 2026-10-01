import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { Receipt } from "../lib/receipt";
import { ReceiptView } from "./receipt-view";

/**
 * Receipt printing — deterministic render of the print-only receipt view. The view
 * is presentational (no queries, no router): with a fixed Receipt fixture,
 * the exact document that reaches the paper is asserted — store identity,
 * header, lines, totals, paid/remaining and payment history, with RTL root
 * and ltr spans for dates/numbers.
 */

const receipt: Receipt = {
  storeName: "دكان التجربة",
  storePhone: "+213550123123",
  invoiceNumber: "INV-0007",
  kind: "SALE",
  invoiceDate: "2026-08-25",
  counterpartyName: "زبون النقد",
  notes: "توصيل للنهار",
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

function renderReceipt(data: Receipt) {
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<ReceiptView receipt={data} />);
  });
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ").trim();

describe("ReceiptView — document content", () => {
  it("prints the store identity, invoice number, date and party", () => {
    renderReceipt(receipt);
    expect(text()).toContain("دكان التجربة");
    expect(text()).toContain("+213550123123");
    expect(text()).toContain("INV-0007");
    expect(text()).toContain("25/08/2026");
    expect(text()).toContain("زبون النقد");
    expect(text()).toContain("توصيل للنهار");
  });

  it("renders every line with quantity, unit price and net total", () => {
    renderReceipt(receipt);
    const lines = Array.from(host.querySelectorAll('[data-testid="receipt-line"]'));
    const cells = lines.map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
    expect(cells).toEqual([
      ["بطارية", "2", "550 دج", "1000 دج"],
      ["تركيب", "1", "100 دج", "50 دج"],
    ]);
  });

  it("prints subtotal, discount, total, paid and remaining exactly as assembled", () => {
    renderReceipt(receipt);
    expect(host.querySelector('[data-testid="receipt-subtotal"]')?.textContent).toBe("1000 دج");
    expect(host.querySelector('[data-testid="receipt-discount"]')?.textContent).toBe("-100 دج");
    expect(host.querySelector('[data-testid="receipt-total"]')?.textContent).toBe("950 دج");
    expect(host.querySelector('[data-testid="receipt-paid"]')?.textContent).toBe("500 دج");
    expect(host.querySelector('[data-testid="receipt-remaining"]')?.textContent).toBe("450 دج");
  });

  it("shows a zero discount and the invoice kind label in the header", () => {
    renderReceipt({ ...receipt, discountAmount: 0 });
    expect(host.querySelector('[data-testid="receipt-discount"]')?.textContent).toBe("0 دج");
    expect(text()).toContain("بيع"); // invoiceKind_SALE label
  });

  it("prints the party cell separately from the free-form document text", () => {
    renderReceipt(receipt);
    expect(host.querySelector('[data-testid="receipt-party"]')?.textContent).toBe("زبون النقد");
  });

  it("prints the full payment history in order", () => {
    renderReceipt(receipt);
    const rows = Array.from(host.querySelectorAll('[data-testid="receipt-payment"]'));
    const cells = rows.map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
    expect(cells).toEqual([
      // issue #119: payment moments render day-first, 24-hour, no T/seconds
      ["25/08/2026 10:01", "300 دج", "نقداً", "أول دفعة"],
      ["25/08/2026 11:30", "200 دج", "تحويل بنكي", "—"],
    ]);
  });

  it("renders a paid-off invoice with remaining zero", () => {
    renderReceipt({ ...receipt, paidAmount: 950, remainingAmount: 0, payments: receipt.payments });
    expect(host.querySelector('[data-testid="receipt-paid"]')?.textContent).toBe("950 دج");
    expect(host.querySelector('[data-testid="receipt-remaining"]')?.textContent).toBe("0 دج");
  });

  it("shows an empty-payments notice instead of a phantom table", () => {
    renderReceipt({ ...receipt, payments: [] });
    expect(host.querySelector('[data-testid="receipt-payments-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="receipt-payment"]')).toBeNull();
  });

  it("hides the notes row and skips the phone line when absent", () => {
    renderReceipt({ ...receipt, notes: null, storePhone: null });
    expect(host.querySelector('[data-testid="receipt-notes"]')).toBeNull();
    expect(host.querySelector('[data-testid="receipt-phone"]')).toBeNull();
    expect(text()).toContain("بطارية"); // the rest of the document stays intact
  });
});

describe("ReceiptView — RTL layout tokens", () => {
  it("roots the document in rtl", () => {
    renderReceipt(receipt);
    expect(host.querySelector('[data-testid="receipt-view"]')?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the invoice number and phone left-to-right, and the date day-first", () => {
    renderReceipt(receipt);
    // issue #119: a `DD/MM/YYYY` value is a single left-to-right number run, so
    // the shared formatter needs no LTR wrapper — one would also flip the
    // cell's `text-align: start` to the left
    expect(host.querySelector('[data-testid="receipt-date"]')?.getAttribute("dir")).toBeNull();
    expect(host.querySelector('[data-testid="receipt-date"]')?.textContent).toBe("25/08/2026");
    expect(host.querySelector('[data-testid="receipt-number"]')?.getAttribute("dir")).toBe("ltr");
    expect(host.querySelector('[data-testid="receipt-phone"]')?.getAttribute("dir")).toBe("ltr");
  });

  it("leaves the payment timestamp unwrapped so the date reads on the right", () => {
    renderReceipt(receipt);
    const firstDateCell = host.querySelector('[data-testid="receipt-payment"] td');
    expect(firstDateCell?.getAttribute("dir")).toBeNull();
    // the logical string is day-first; the RTL run order puts the date on the
    // right and its time on the left
    expect(firstDateCell?.textContent).toBe("25/08/2026 10:01");
  });
});