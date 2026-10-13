import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly;
// only this flag is written and globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { Invoice, SupplierReturn } from "@dokan/contracts";

const submitted: unknown[] = [];
mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersReturn: {
      mutationOptions: (options?: { onSuccess?: () => void }) => ({
        mutationKey: ["suppliersReturn"],
        ...options,
        mutationFn: async (input: SupplierReturn) => {
          submitted.push(input);
          return {};
        },
      }),
    },
    invoicesGet: {
      queryOptions: () => ({
        queryKey: ["invoicesGet", "inv-1"],
        queryFn: async () => ({
          id: "inv-1",
          kind: "PURCHASE",
          lines: [{ id: "l1", itemId: "item-1", description: "هدية", quantity: 5, unitPrice: 0, netTotal: 0 }],
        }),
      }),
    },
    itemsList: { queryOptions: () => ({ queryKey: ["itemsList"], queryFn: async () => ({ items: [] }) }) },
    suppliersGet: { queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id] },
    suppliersReturnsList: { queryKey: () => ["suppliersReturnsList"] },
  },
  rpcClient: {},
}));

const { SupplierReturnPanel } = await import("./supplier-return-panel");

const invoice: Invoice = {
  id: "inv-1",
  invoiceNumber: "INV-0001",
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  kind: "PURCHASE",
  counterpartyId: "sup-1",
  counterpartyName: "مورد",
  totalAmount: 0,
  paidAmount: 0,
  remainingAmount: 0,
  subtotalAmount: 0,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  updatedAt: "2026-01-01T10:00:00",
};

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  submitted.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierReturnPanel supplierId="sup-1" invoices={[invoice]} onDone={() => undefined} onCancel={() => undefined} />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (host.querySelector('[data-testid="supplier-return-lines"]') !== null) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("return lines did not render");
}

function typeInto(testId: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function confirmButton() {
  return host.querySelector<HTMLButtonElement>('[data-testid="supplier-return-confirm"]');
}

async function submit() {
  const form = host.querySelector<HTMLFormElement>('[data-testid="supplier-return-panel"]');
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("SupplierReturnPanel draft validation (findings 3 and 8)", () => {
  it("enables submit for a valid quantity on a free line (zero return value)", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1");
    expect(confirmButton()?.disabled).toBe(false);
  });

  it("rejects a fractional quantity instead of silently dropping it", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("rejects a malformed cash-back instead of omitting the refund", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1");
    typeInto("supplier-return-cash", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("submits exactly the selected line and the parsed cash-back", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "2");
    typeInto("supplier-return-cash", "100");
    await submit();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      supplierId: "sup-1",
      invoiceId: "inv-1",
      lines: [{ invoiceLineId: "l1", quantity: 2 }],
      cashBack: 100,
    });
  });
});
