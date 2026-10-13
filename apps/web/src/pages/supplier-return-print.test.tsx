import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly;
// only this flag is written and globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { SupplierReturnRecord } from "@dokan/contracts";

import { routerMock } from "@/tests/router-mock";

// mutable route params: the regression test switches to an older return id
const params = { partyId: "sup-1", returnId: "ret-1" };
mock.module("@tanstack/react-router", () => routerMock(params));

/** The voucher on the list's first page. */
const firstVoucher = {
  id: "ret-1",
  returnNumber: "PRT-0001",
  supplierId: "sup-1",
  supplierName: "شركة الأمل",
  invoiceId: null,
  invoiceNumber: null,
  kind: "FREE_STANDING",
  amount: 300,
  debtReduction: 0,
  credit: 300,
  cashBack: 0,
  reason: null,
  occurredAt: "2026-01-01T10:00:00",
  createdAt: "2026-01-01T10:00:00",
  lines: [{ id: "sl-1", returnId: "ret-1", invoiceLineId: null, itemId: "item-1", description: "هدية", quantity: 1, unitCost: 999, amount: 300 }],
} satisfies SupplierReturnRecord;

/** An older voucher the paginated list's first page does NOT carry. */
const oldVoucher = {
  id: "ret-old",
  returnNumber: "PRT-0099",
  supplierId: "sup-1",
  supplierName: "شركة الأمل",
  invoiceId: "inv-9",
  invoiceNumber: "INV-0009",
  kind: "INVOICE_LINKED",
  amount: 500,
  debtReduction: 500,
  credit: 0,
  cashBack: 0,
  reason: null,
  occurredAt: "2025-01-01T10:00:00",
  createdAt: "2025-01-01T10:00:00",
  lines: [{ id: "sl-2", returnId: "ret-old", invoiceLineId: "il-9", itemId: "item-1", description: "فلتر", quantity: 2, unitCost: 250, amount: 500 }],
} satisfies SupplierReturnRecord;

mock.module("@/lib/rpc", () => ({
  orpc: {
    // the voucher print page reads one return by id (issue #163 review)
    suppliersReturnGet: {
      queryOptions: ({ input }: { input: { returnId: string } }) => ({
        queryKey: ["suppliersReturnGet", input.returnId],
        queryFn: async () => (input.returnId === "ret-old" ? oldVoucher : firstVoucher),
      }),
    },
    // page one of the list deliberately does NOT contain the older voucher:
    // scanning this list (the old implementation) could never open it
    suppliersReturnsList: {
      queryOptions: () => ({
        queryKey: ["suppliersReturnsList", "sup-1"],
        queryFn: async () => ({ items: [firstVoucher], total: 11 }),
      }),
    },
    settingsGet: { queryOptions: () => ({ queryKey: ["settingsGet"], queryFn: async () => ({ storeName: "متجر", storePhone: null, storeAddress: null }) }) },
  },
  rpcClient: {},
}));

const { SupplierReturnPrintPage } = await import("./supplier-return-print");

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  params.partyId = "sup-1";
  params.returnId = "ret-1";
  host = document.createElement("div");
  document.body.appendChild(host);
  // the page auto-prints after a delay; stub it so the test never blocks
  Object.defineProperty(window, "print", { value: () => undefined, configurable: true });
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierReturnPrintPage />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (host.querySelector('[data-testid="supplier-return-voucher-page"]') !== null) return;
    if (host.querySelector('[data-testid="supplier-return-voucher-error"]') !== null) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("voucher did not render");
}

describe("supplier return voucher (findings 5 and 6)", () => {
  it("names the supplier so the page identifies who holds the goods", async () => {
    await render();
    expect(host.querySelector('[data-testid="supplier-return-voucher-supplier-name"]')?.textContent).toContain("شركة الأمل");
  });

  it("omits the stock cost as the unit price for a free-standing return", async () => {
    await render();
    const unit = host.querySelector('[data-testid="supplier-return-voucher-unit"]');
    expect(unit?.textContent).toContain("—");
    // the item's stock cost (999) must not be printed as the agreed price
    expect(unit?.textContent).not.toContain("999");
  });

  it("opens an older voucher that is not on the list's first page (issue #163 review)", async () => {
    params.returnId = "ret-old";
    await render();
    // the by-id read rendered the voucher even though the paginated list's
    // page one only carried PRT-0001
    expect(host.querySelector('[data-testid="supplier-return-voucher-page"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="supplier-return-voucher-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="supplier-return-voucher-number"]')?.textContent).toContain("PRT-0099");
  });
});
