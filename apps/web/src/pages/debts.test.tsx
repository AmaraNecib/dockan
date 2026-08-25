import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

type Summary = {
  counterpartyId: string | null;
  counterpartyName: string | null;
  kind: "SALE" | "PURCHASE";
  remainingTotal: number;
  invoiceCount: number;
  oldestInvoiceDate: string | null;
  latestInvoiceDate: string | null;
};

type Invoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  remainingAmount: number;
};

let owedToUs: Summary[] = [];
let weOwe: Summary[] = [];
let perParty: Map<string, Invoice[]> = new Map();

// The page resolves both queries through orpc.*.queryOptions; mock the rpc
// module so tests drive fixtures without a network seam. debtsByParty keys on
// the typed identity (name when id is null), which is what the page sends.
mock.module("@/lib/rpc", () => ({
  orpc: {
    reportsDebts: {
      queryOptions: () => ({
        queryKey: ["reportsDebts"],
        queryFn: async () => ({ owedToUs, weOwe }),
      }),
    },
    debtsByParty: {
      // SAFETY: mirror the real tanstack-query utils signature ({ input })
      queryOptions: ({ input }: { input: { kind: "SALE" | "PURCHASE"; counterpartyId: string | null; counterpartyName: string | null } }) => ({
        queryKey: ["debtsByParty", input],
        queryFn: async (): Promise<{ items: Invoice[]; totalCount: number }> => {
          const key = `${input.kind}:${input.counterpartyId ?? input.counterpartyName}`;
          const items = perParty.get(key) ?? [];
          return { items, totalCount: items.length };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { DebtsPage } = await import("./debts");

const summary = (over: Partial<Summary> = {}): Summary => ({
  counterpartyId: null,
  counterpartyName: "زبون مدين",
  kind: "SALE",
  remainingTotal: 600,
  invoiceCount: 1,
  oldestInvoiceDate: "2026-08-01",
  latestInvoiceDate: "2026-08-01",
  ...over,
});

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  invoiceNumber: "INV-0201",
  invoiceDate: "2026-08-01",
  totalAmount: 1_000,
  remainingAmount: 600,
  ...over,
});

async function mountPage(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DebtsPage />
      </QueryClientProvider>,
    );
  });
  return {
    text: () => container.textContent ?? "",
    personButtons: () => container.querySelectorAll<HTMLButtonElement>("button[data-testid='debts-person']"),
    invoiceRows: () => container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='debts-invoice-row']"),
    emptyOwed: () => container.querySelector<HTMLElement>("[data-testid='debts-group-owed-empty']"),
    emptyWeOwe: () => container.querySelector<HTMLElement>("[data-testid='debts-group-weowe-empty']"),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    waitFor: async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (check()) return true;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      return false;
    },
  };
}

describe("DebtsPage (ticket 9)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
    owedToUs = [];
    weOwe = [];
    perParty = new Map();
  });

  afterEach(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
  });

  it("renders both debt directions with per-person totals and invoice counts", async () => {
    owedToUs = [summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 })];
    weOwe = [summary({ kind: "PURCHASE", counterpartyName: "مورد مستحق", remainingTotal: 800, invoiceCount: 2 })];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    expect(ui.text()).toContain("مستحقاتنا عند الزبائن");
    expect(ui.text()).toContain("مستحقات الموردين عندنا");
    expect(ui.text()).toContain("زبون مدين");
    expect(ui.text()).toContain("مورد مستحق");
    // per-person remaining totals + counts
    expect(ui.text()).toContain("600 دج");
    expect(ui.text()).toContain("800 دج");
    expect(ui.text()).toContain("عدد الفواتير: 2");

    await ui.unmount();
  });

  it("shows an empty state per group when nobody owes anything", async () => {
    owedToUs = [];
    weOwe = [];
    const ui = await mountPage(queryClient);
    const appeared = await ui.waitFor(() => ui.emptyOwed() !== null && ui.emptyWeOwe() !== null);
    expect(appeared).toBe(true);
    await ui.unmount();
  });

  it("expands a person row to its unpaid invoices and collapses again", async () => {
    owedToUs = [summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 })];
    perParty.set("SALE:زبون مدين", [invoice()]);

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 1);
    expect(loaded).toBe(true);
    expect(ui.invoiceRows()).toHaveLength(0);

    // expand → the drill-down invoices appear with totals
    await act(async () => {
      ui.personButtons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const expanded = await ui.waitFor(() => ui.invoiceRows().length === 1);
    expect(expanded).toBe(true);
    const cells = ui.invoiceRows()[0]!.textContent ?? "";
    expect(cells).toContain("INV-0201");
    expect(cells).toContain("2026-08-01");
    expect(cells).toContain("1000 دج");
    expect(cells).toContain("600 دج");

    // collapse → invoices hidden again
    await act(async () => {
      ui.personButtons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(ui.invoiceRows()).toHaveLength(0);

    await ui.unmount();
  });

  it("keeps one direction's invoices out of the other direction's rows", async () => {
    owedToUs = [summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 })];
    weOwe = [summary({ kind: "PURCHASE", counterpartyName: "مورد مستحق", remainingTotal: 800, invoiceCount: 1 })];
    perParty.set("SALE:زبون مدين", [invoice({ invoiceNumber: "INV-SALE-1" })]);
    perParty.set("PURCHASE:مورد مستحق", [invoice({ invoiceNumber: "INV-PUR-1", totalAmount: 1_300, remainingAmount: 800 })]);

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    // expand the weOwe supplier: only its purchase invoice shows
    const weOweButton = ui.personButtons()[1]!;
    await act(async () => {
      weOweButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const expanded = await ui.waitFor(() => ui.invoiceRows().length === 1);
    expect(expanded).toBe(true);
    const cells = ui.invoiceRows()[0]!.textContent ?? "";
    expect(cells).toContain("INV-PUR-1");
    expect(cells).not.toContain("INV-SALE-1");

    await ui.unmount();
  });
});