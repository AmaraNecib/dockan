import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { Invoice, SupplierAdjustmentDirection } from "@dokan/contracts";

type AdjustInput = {
  supplierId: string;
  direction: SupplierAdjustmentDirection;
  amount: number;
  reason?: string;
  occurredAt?: string;
  invoiceId?: string;
};

let captured: AdjustInput | null = null;
mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersAdjust: {
      mutationOptions: () => ({
        mutationKey: ["suppliersAdjust"],
        mutationFn: async (input: AdjustInput) => {
          captured = input;
          return { balance: 0, entries: [] };
        },
      }),
    },
    suppliersGet: { queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id] },
  },
  rpcClient: {},
}));

const { SupplierAdjustPanel } = await import("./supplier-adjust-panel");

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  invoiceNumber: "INV-0007",
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  kind: "PURCHASE",
  counterpartyId: "sup-1",
  counterpartyName: "مورد",
  totalAmount: 5000,
  paidAmount: 0,
  remainingAmount: 5000,
  subtotalAmount: 5000,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  updatedAt: "2026-01-01T10:00:00",
  ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  captured = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

function render(invoices: Invoice[] = [invoice()]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierAdjustPanel supplierId="sup-1" supplierName="مورد الاختبار" balance={5000} invoices={invoices} onDone={() => undefined} onCancel={() => undefined} />
      </QueryClientProvider>,
    );
  });
}

function input(testId: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  return el;
}

function typeInto(testId: string, text: string) {
  const el = input(testId);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickOn(testId: string) {
  const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  act(() => el.click());
}

describe("SupplierAdjustPanel (issue 176)", () => {
  it("saves an account-only adjustment with the chosen direction and no invoice", async () => {
    render();
    clickOn("supplier-adjust-direction-they-owe");
    typeInto("supplier-adjust-amount", "500");
    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    expect(captured).toMatchObject({ supplierId: "sup-1", direction: "THEY_OWE", amount: 500 });
    expect(captured?.invoiceId).toBeUndefined();
    // the account-only preview explicitly says no invoice changes
    expect(host.querySelector('[data-testid="supplier-adjust-preview"]')?.textContent).toContain("لا تتغيّر");
  });

  it("links the invoice, forces يسالنا, and refuses an amount above the remaining", () => {
    render();
    clickOn("supplier-adjust-link");
    // linking forces the reducing direction, so the increase button is disabled
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-direction-we-owe"]')?.disabled).toBe(true);

    typeInto("supplier-adjust-amount", "6000");
    expect(host.querySelector('[data-testid="supplier-adjust-error"]')?.textContent).toContain("يتجاوز");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);

    // a fitting amount previews the invoice remaining after saving
    typeInto("supplier-adjust-amount", "500");
    expect(host.querySelector('[data-testid="supplier-adjust-preview-remaining"]')?.textContent).toContain("4500");
  });

  it("offers no link when there is no open purchase invoice", () => {
    render([]);
    clickOn("supplier-adjust-link");
    expect(host.querySelector('[data-testid="supplier-adjust-no-invoices"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
  });
});
