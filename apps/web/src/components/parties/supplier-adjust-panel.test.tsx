import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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
    reportsDebts: { queryKey: () => ["reportsDebts"] },
    dashboardSummary: { queryKey: () => ["dashboardSummary"] },
  },
  DEBTS_BY_PARTY_QUERY_KEY: [["debtsByParty"]],
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
let queryClient: QueryClient | null = null;

beforeEach(() => {
  captured = null;
  queryClient = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

function tree(invoices: Invoice[]) {
  return (
    <QueryClientProvider client={queryClient!}>
      <SupplierAdjustPanel supplierId="sup-1" supplierName="مورد الاختبار" balance={5000} invoices={invoices} onDone={() => undefined} onCancel={() => undefined} />
    </QueryClientProvider>
  );
}

function render(invoices: Invoice[] = [invoice()]) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(tree(invoices));
  });
}

/** Re-render the SAME panel with a new invoices prop (the background refresh). */
function rerender(invoices: Invoice[]) {
  act(() => {
    root!.render(tree(invoices));
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

  it("never auto-switches the linked invoice when the selected one is no longer open (Greptile finding 2)", () => {
    render([invoice({ id: "inv-a", invoiceNumber: "INV-A" }), invoice({ id: "inv-b", invoiceNumber: "INV-B" })]);
    clickOn("supplier-adjust-link");
    // the owner's selected invoice A settles in another tab; a refresh drops it
    rerender([invoice({ id: "inv-b", invoiceNumber: "INV-B" })]);
    typeInto("supplier-adjust-amount", "100");

    expect(host.querySelector('[data-testid="supplier-adjust-link-error"]')?.textContent).toContain("لم تعد مفتوحة");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
    clickOn("supplier-adjust-confirm");
    // nothing was submitted, and B was never silently discounted
    expect(captured).toBeNull();
  });

  it("accepts the same grouped amount as the bulk opening-balance screen (#180)", async () => {
    render();
    clickOn("supplier-adjust-direction-they-owe");
    typeInto("supplier-adjust-amount", "1 000");
    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    // the shared grouped parser: `1 000` is 1000 here, exactly as in the bulk rows
    expect(captured).toMatchObject({ supplierId: "sup-1", direction: "THEY_OWE", amount: 1000 });
  });

  it("rejects a decimal-grouped amount instead of guessing 100x (#180)", () => {
    render();
    typeInto("supplier-adjust-amount", "1 000,00");
    expect(host.querySelector('[data-testid="supplier-adjust-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("invalidates the real debts and dashboard keys after saving (Greptile finding 5)", async () => {
    render();
    typeInto("supplier-adjust-amount", "500");
    const spy = spyOn(queryClient!, "invalidateQueries");

    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["reportsDebts"]));
    expect(keys).toContain(JSON.stringify([["debtsByParty"]]));
    expect(keys).toContain(JSON.stringify(["dashboardSummary"]));
    expect(keys).toContain(JSON.stringify([["invoicesList"]]));
    expect(keys).toContain(JSON.stringify([["activitiesList"]]));
    expect(keys).not.toContain(JSON.stringify(["debtsData"]));
  });
});
