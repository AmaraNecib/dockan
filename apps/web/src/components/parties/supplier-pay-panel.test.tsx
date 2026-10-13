import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly;
// only this flag is written and globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { Invoice } from "@dokan/contracts";

mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersPay: {
      mutationOptions: (options?: { onSuccess?: () => void }) => ({
        mutationKey: ["suppliersPay"],
        ...options,
        mutationFn: async () => ({}),
      }),
    },
    suppliersGet: { queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id] },
  },
  rpcClient: {},
}));

const { SupplierPayPanel } = await import("./supplier-pay-panel");

/**
 * Regression (issue 161, Greptile finding 4): the oldest-first preview must
 * pass the FULL amount to the distribution, exactly as `suppliersPay` does.
 * With an 800 balance (a 1000 invoice minus a 200 credit) and a 900 payment,
 * the server applies all 900 to the invoice; the preview must not cap at 800
 * and invent a 100 credit.
 */
const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  kind: "PURCHASE",
  counterpartyId: "sup-1",
  counterpartyName: "مورد",
  totalAmount: 1000,
  paidAmount: 0,
  remainingAmount: 1000,
  subtotalAmount: 1000,
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
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

function render(balance: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierPayPanel supplierId="sup-1" balance={balance} invoices={[invoice()]} onDone={() => undefined} onCancel={() => undefined} />
      </QueryClientProvider>,
    );
  });
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

describe("SupplierPayPanel oldest-first preview (finding 4)", () => {
  it("previews the full amount across the invoice, not a credit invented by capping at the balance", () => {
    // balance 800 = 1000 invoice − 200 credit; pay 900
    render(800);
    typeInto("supplier-pay-amount", "900");
    const line = host.querySelector('[data-testid="supplier-pay-line"]');
    expect(line?.textContent).toContain("900");
    // no credit line: the whole 900 fits the 1000 invoice
    expect(host.querySelector('[data-testid="supplier-pay-credit"]')).toBeNull();
  });

  it("shows a credit only for the part no invoice can absorb", () => {
    render(800);
    typeInto("supplier-pay-amount", "1200");
    const line = host.querySelector('[data-testid="supplier-pay-line"]');
    expect(line?.textContent).toContain("1000");
    expect(host.querySelector('[data-testid="supplier-pay-credit"]')?.textContent).toContain("200");
  });
});
