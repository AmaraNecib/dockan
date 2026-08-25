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
/** when set to a party key, the drill-down for that party rejects */
let failingParty: string | null = null;

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
          // RPC errors carry stable server keys; tError translates them
          if (failingParty === key) throw new Error("INVOICE_NOT_FOUND");
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
    personNamed: (name: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-testid='debts-person']")).find((button) =>
        button.textContent?.includes(name),
      ),
    invoiceRows: () => container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='debts-invoice-row']"),
    groupTotal: (label: string) => container.querySelector<HTMLElement>(`[data-testid='${label}-total']`),
    groupCount: (label: string) => container.querySelector<HTMLElement>(`[data-testid='${label}-count']`),
    alert: () => container.querySelector<HTMLElement>("[role='alert']"),
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
    failingParty = null;
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

  it("sums per-group totals and invoice counts independently of any single row", async () => {
    owedToUs = [
      summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 }),
      summary({ counterpartyName: "زبون ثان", remainingTotal: 800, invoiceCount: 2 }),
    ];
    weOwe = [summary({ kind: "PURCHASE", counterpartyName: "مورد مستحق", remainingTotal: 1_200, invoiceCount: 3 })];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 3);
    expect(loaded).toBe(true);

    expect(ui.groupTotal("debts-group-owed")?.textContent).toContain("1400 دج");
    expect(ui.groupCount("debts-group-owed")?.textContent).toBe("3");
    expect(ui.groupTotal("debts-group-weowe")?.textContent).toContain("1200 دج");
    expect(ui.groupCount("debts-group-weowe")?.textContent).toBe("3");

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

    // expand the weOwe supplier (found by name, not by DOM order): only its
    // purchase invoice shows
    const weOweButton = ui.personNamed("مورد مستحق");
    expect(weOweButton).toBeDefined();
    await act(async () => {
      weOweButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const expanded = await ui.waitFor(() => ui.invoiceRows().length === 1);
    expect(expanded).toBe(true);
    const cells = ui.invoiceRows()[0]!.textContent ?? "";
    expect(cells).toContain("INV-PUR-1");
    expect(cells).not.toContain("INV-SALE-1");

    await ui.unmount();
  });

  it("opens only one person's invoices at a time across groups", async () => {
    owedToUs = [summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 })];
    weOwe = [summary({ kind: "PURCHASE", counterpartyName: "مورد مستحق", remainingTotal: 800, invoiceCount: 1 })];
    perParty.set("SALE:زبون مدين", [invoice({ invoiceNumber: "INV-SALE-1" })]);
    perParty.set("PURCHASE:مورد مستحق", [invoice({ invoiceNumber: "INV-PUR-1" })]);

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    await act(async () => {
      ui.personNamed("زبون مدين")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await ui.waitFor(() => ui.invoiceRows().length === 1);
    expect(ui.invoiceRows()[0]!.textContent).toContain("INV-SALE-1");

    // opening the supplier's row closes the customer's and shows its own list
    await act(async () => {
      ui.personNamed("مورد مستحق")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const swapped = await ui.waitFor(() => {
      const rows = Array.from(ui.invoiceRows()).map((row) => row.textContent ?? "");
      return rows.length === 1 && rows[0]!.includes("INV-PUR-1");
    });
    expect(swapped).toBe(true);

    await ui.unmount();
  });

  it("shows an empty drill-down and an error drill-down inside an expanded row", async () => {
    owedToUs = [
      summary({ counterpartyName: "زبون بلا فواتير", remainingTotal: 600, invoiceCount: 1 }),
      summary({ counterpartyName: "زبون فاشل", remainingTotal: 900, invoiceCount: 1 }),
    ];
    perParty.set("SALE:زبون بلا فواتير", []);
    failingParty = "SALE:زبون فاشل";

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    // party whose drill-down is legitimately empty (summary/drill-down drift)
    await act(async () => {
      ui.personNamed("زبون بلا فواتير")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const emptyShown = await ui.waitFor(() => ui.text().includes("لا توجد ديون حالياً"));
    expect(emptyShown).toBe(true);
    expect(ui.invoiceRows()).toHaveLength(0);

    await act(async () => {
      ui.personNamed("زبون بلا فواتير")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      ui.personNamed("زبون فاشل")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const errorShown = await ui.waitFor(() => ui.alert() !== null);
    expect(errorShown).toBe(true);
    expect(ui.alert()!.textContent).toContain("الفاتورة غير موجودة");
    expect(ui.invoiceRows()).toHaveLength(0);

    await ui.unmount();
  });

  it("renders an id-backed party by its id when the invoice has no name", async () => {
    const PARTY_ID = "00000000-0000-4000-8000-0000000000cd";
    owedToUs = [summary({ counterpartyId: PARTY_ID, counterpartyName: null, remainingTotal: 400, invoiceCount: 1 })];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 1);
    expect(loaded).toBe(true);
    expect(ui.text()).toContain(PARTY_ID);

    await ui.unmount();
  });
});