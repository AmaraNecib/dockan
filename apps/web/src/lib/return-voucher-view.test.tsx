import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { ReturnVoucherView } from "../components/return-voucher-view";
import { buildReturnVoucher } from "./return-voucher";
import type { ReturnDetail } from "@dokan/contracts";

function makeReturn(): ReturnDetail {
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
  };
}

let roots: Array<{ unmount: () => void }> = [];
let host = document.createElement("div");

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  host.remove();
});

function renderVoucher(voucher: ReturnVoucherType) {
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<ReturnVoucherView voucher={voucher} />);
  });
}

type ReturnVoucherType = ReturnType<typeof buildReturnVoucher>;

describe("ReturnVoucherView (printable voucher document)", () => {
  it("renders the store identity, return + invoice numbers, lines and refund total", () => {
    const voucher = buildReturnVoucher(makeReturn(), { storeName: "متجر الكرامة", storePhone: "+213661234567" });
    renderVoucher(voucher);
    const view = host.querySelector('[data-testid="return-voucher-view"]')!;
    expect(view.querySelector('[data-testid="return-voucher-store"]')?.textContent).toBe("متجر الكرامة");
    expect(view.querySelector('[data-testid="return-voucher-phone"]')?.textContent).toBe("+213661234567");
    expect(view.querySelector('[data-testid="return-voucher-number"]')?.textContent).toBe("RTN-0042");
    expect(view.querySelector('[data-testid="return-voucher-invoice"]')?.textContent).toBe("INV-0101");
    expect(view.querySelector('[data-testid="return-voucher-party"]')?.textContent).toBe("يوسف");
    expect(view.querySelector('[data-testid="return-voucher-total"]')?.textContent).toContain("1700");
    expect(view.querySelector('[data-testid="return-voucher-cash"]')?.textContent).toContain("1700");
    expect(view.querySelector('[data-testid="return-voucher-debt"]')?.textContent).toContain("0");
    // one line with its refund unit price and amount
    const line = view.querySelector('[data-testid="return-voucher-line"]')!;
    expect(line.textContent).toContain("بطارية");
    expect(line.textContent).toContain("850");
    expect(line.textContent).toContain("1700");
    expect(view.querySelector('[data-testid="return-voucher-status"]')?.textContent).toContain("قيد المراجعة");
    expect(view.querySelector('[data-testid="return-voucher-reason"]')?.textContent).toContain("الزبون بدل رأيه");
  });
});