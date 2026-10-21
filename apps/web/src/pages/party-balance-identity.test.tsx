import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { DebtSummary, Invoice, InvoiceDetail, ReturnDetail } from "@dokan/contracts";

import { routerMock } from "../tests/router-mock";

/**
 * #323 — one party, one cache identity.
 *
 * A party is keyed by its id on one screen and by its id AND the typed name on
 * the other, so the two screens held two cache entries for the same party and
 * a payment invalidated one of them. The open screen kept previewing a refund
 * against a total the write had already moved.
 *
 * These tests drive the real screens through their real surfaces: the debts
 * screen (the drill-down), the invoice screen (the refund preview) and the
 * party screen (the settle panel), all on ONE query cache — which is what a
 * shop owner has when two tabs are open.
 */

const PARTY_ID = "00000000-0000-4000-8000-0000000000f1";
const INVOICE_ID = "00000000-0000-4000-8000-0000000000f2";
const OPEN_INVOICE_ID = "00000000-0000-4000-8000-0000000000f3";
const LINE_ID = "00000000-0000-4000-8000-0000000000f4";
const ITEM_ID = "00000000-0000-4000-8000-0000000000f5";

/** the customer's open invoices — the tab `debtsByParty` returns */
let openInvoices: Array<{ id: string; remainingAmount: number }> = [];
/** the debts screen's rows */
let owedToUs: DebtSummary[] = [];
let weOwe: DebtSummary[] = [];

// the page modules import the router Link at module scope; the shared stub
// keeps the screens testable without a router mount
mock.module("@tanstack/react-router", routerMock);

mock.module("@/lib/rpc", () => ({
  orpc: {
    reportsDebts: {
      queryOptions: () => ({
        queryKey: ["reportsDebts"],
        queryFn: async () => ({ owedToUs, weOwe }),
      }),
      queryKey: () => ["reportsDebts"],
    },
    debtsByParty: {
      // the key carries the party's identity, so both screens read the SAME
      // party under one entry
      queryOptions: ({ input }: { input: { kind: string; counterpartyId: string | null; counterpartyName: string | null } }) => ({
        queryKey: ["debtsByParty", input],
        queryFn: async () => {
          const items = openInvoices
            .filter((row) => row.remainingAmount > 0)
            .map((row) => ({ remainingAmount: row.remainingAmount }));
          return { items, total: items.length };
        },
      }),
      queryKey: ({ input }: { input: { kind: string; counterpartyId: string | null; counterpartyName: string | null } }) => ["debtsByParty", input],
    },
    suppliersGet: {
      queryOptions: () => ({ queryKey: ["suppliersGet", ""], queryFn: async () => ({ account: null }) }),
      queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id],
    },
    customersGet: { queryKey: ({ input }: { input: { id: string } }) => ["customersGet", input.id] },
    invoicesGet: { queryKey: ({ input }: { input: { id: string } }) => ["invoicesGet", input] },
    invoicesList: { queryKey: () => ["invoicesList"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
    returnsPendingCount: { queryKey: () => ["returnsPendingCount"] },
    invoicesPay: {
      mutationOptions: () => ({
        mutationKey: ["invoicesPay"],
        mutationFn: async (input: { invoiceId: string; amount: number }) => {
          // the server settles the invoice: its remaining drops, and a settled
          // invoice leaves the customer's tab
          const target = openInvoices.find((row) => row.id === input.invoiceId);
          if (target === undefined) throw new Error("INVOICE_NOT_FOUND");
          if (input.amount > target.remainingAmount) throw new Error("PAYMENT_EXCEEDS_REMAINING");
          target.remainingAmount = Math.max(0, target.remainingAmount - input.amount);
          return {};
        },
      }),
    },
    returnsForInvoice: {
      queryOptions: () => ({ queryKey: ["returnsForInvoice"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["returnsForInvoice"],
    },
    returnsCreate: {
      mutationOptions: (options?: { onSuccess?: (record: ReturnDetail) => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsCreate"],
        ...options,
        mutationFn: async () => ({}),
      }),
    },
  },
  rpcClient: {},
}));

const { DebtsPage } = await import("./debts");
const { ReturnsPanel } = await import("./invoice");
const { CustomerSettlePanel } = await import("../components/parties/customer-settle-panel");

const summary = (over: Partial<DebtSummary> = {}): DebtSummary => ({
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  kind: "SALE" as const,
  remainingTotal: 900,
  invoiceCount: 1,
  oldestInvoiceDate: "2026-08-01",
  latestInvoiceDate: "2026-08-01",
  accountBalance: null,
  ...over,
});

/** the invoice screen's invoice: paid in full, so the party's TAB is what the
 * refund preview is derived from */
const invoiceDetail = (over: Partial<InvoiceDetail> = {}): InvoiceDetail => ({
  id: INVOICE_ID,
  invoiceNumber: "INV-0301",
  kind: "SALE",
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  invoiceDate: "2026-08-01",
  subtotalAmount: 900,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  totalAmount: 900,
  paidAmount: 900,
  remainingAmount: 0,
  returnCreditAmount: 0,
  notes: null,
  createdAt: "2026-08-01T10:00:00",
  updatedAt: "2026-08-01T10:00:00",
  lines: [
    {
      id: LINE_ID,
      invoiceId: INVOICE_ID,
      itemId: ITEM_ID,
      description: "بطارية",
      quantity: 4,
      defaultUnitPrice: 900,
      unitPrice: 900,
      costAtSale: 400,
      cogsExact: 1600,
      total: 3600,
      discountAllocated: 0,
      netTotal: 3600,
    },
  ],
  payments: [],
  ...over,
});

/** the party's open invoice, the one the settle panel pays */
const openInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: OPEN_INVOICE_ID,
  invoiceNumber: "INV-0302",
  invoiceDate: "2026-08-01",
  createdAt: "2026-08-01T10:00:00",
  updatedAt: "2026-08-01T10:00:00",
  kind: "SALE",
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  totalAmount: 900,
  paidAmount: 0,
  remainingAmount: 900,
  subtotalAmount: 900,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  openInvoices = [];
  owedToUs = [];
  weOwe = [];
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  queryClient?.clear();
  queryClient = null;
  host.remove();
});

/** mounts the given screens on ONE query cache, the way two open tabs share it */
function renderScreens(children: ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient = client;
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    );
  });
  return client;
}

/** Sets a controlled input through the native setter + input event so React's
 * onChange fires (plain .value assignment is ignored by React's tracker). */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** act-wrapped polling, so a refetch and its re-render both land */
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return false;
}

/** the cache entries one party is read under */
function partyBalanceEntries(client: QueryClient, partyId: string) {
  return client
    .getQueryCache()
    .findAll({ queryKey: ["debtsByParty"] })
    .map((query) => {
      // SAFETY: the mocked key is ["debtsByParty", input]; the second element
      // is the party's identity, or undefined for a key that carries none
      const input = query.queryKey[1] as { kind: string; counterpartyId: string | null; counterpartyName: string | null } | undefined;
      return input;
    })
    .filter((input) => input?.counterpartyId === partyId);
}

describe("one party, one cache identity (#323)", () => {
  it("reads the same party under one key on the debts screen and the invoice screen", async () => {
    owedToUs = [summary()];
    const client = renderScreens(
      <>
        <DebtsPage />
        <ReturnsPanel invoice={invoiceDetail()} />
      </>,
    );
    await flushAsync();

    // the debts screen opens the party's drill-down
    const row = host.querySelector<HTMLButtonElement>('[data-testid="debts-person"]');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    // ONE party, ONE cache entry: the two screens must not hold a second copy
    // of the same party under a different key
    const entries = partyBalanceEntries(client, PARTY_ID);
    expect(entries).toHaveLength(1);
    // and the key is derived from the id alone: the name is not part of it
    expect(entries[0]?.counterpartyName).toBeNull();
    expect(entries[0]?.kind).toBe("SALE");
  });

  it("moves the invoice screen's refund preview when a payment lands on the party screen", async () => {
    // the customer owes 900 on ANOTHER invoice; the invoice on screen is paid
    // in full, so the preview is derived from the party's tab
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(
      <>
        <ReturnsPanel invoice={invoiceDetail()} />
        <CustomerSettlePanel
          partyId={PARTY_ID}
          invoices={[openInvoice()]}
          unpaid={900}
          onDone={() => undefined}
          onWriteFailed={() => undefined}
          onCancel={() => undefined}
        />
      </>,
    );
    await flushAsync();

    // return one unit: the tab covers it, so the refund comes off the debt
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("900");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("0");

    // the party screen records the payment
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="party-settle-panel"]')!);
    await flushAsync();

    // the tab is empty now, so the SAME preview must offer cash instead: the
    // payment moved it without a manual refresh
    const moved = await waitFor(
      () => host.querySelector('[data-testid="returns-cash-now"]')?.textContent?.includes("900") ?? false,
    );
    expect(moved).toBe(true);
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("0");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("900");
  });
});
