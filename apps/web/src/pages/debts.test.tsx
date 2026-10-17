import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { routerMock } from "../tests/router-mock";

// the empty-state action renders a router Link; keep this file self-contained
// instead of relying on another test file's mock leaking in
mock.module("@tanstack/react-router", () => routerMock());

type Summary = {
  counterpartyId: string | null;
  counterpartyName: string | null;
  kind: "SALE" | "PURCHASE";
  remainingTotal: number;
  invoiceCount: number;
  oldestInvoiceDate: string | null;
  latestInvoiceDate: string | null;
  accountBalance: number | null;
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

type SupplierEntry = {
  id: string;
  supplierId: string;
  kind: "PURCHASE" | "PAYMENT" | "RETURN" | "REFUND" | "ADJUSTMENT";
  amount: number;
  direction: "WE_OWE" | "THEY_OWE" | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  method: string | null;
  note: string | null;
  ref: string | null;
  occurredAt: string;
  createdAt: string;
};
/** the expanded supplier row's account movements (#161/#176) */
let supplierAccount: { balance: number; entries: SupplierEntry[] } | null = null;

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
    // #161 — the expanded supplier row reads its account movements
    suppliersGet: {
      queryOptions: ({ input }: { input: { id: string } }) => ({
        queryKey: ["suppliersGet", input],
        queryFn: async () => ({ account: supplierAccount }),
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
  accountBalance: null,
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
    supplierAccount = null;
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

    expect(ui.groupTotal("debts-group-owed")?.textContent).toContain("1,400 دج");
    expect(ui.groupCount("debts-group-owed")?.textContent).toBe("3");
    expect(ui.groupTotal("debts-group-weowe")?.textContent).toContain("1,200 دج");
    expect(ui.groupCount("debts-group-weowe")?.textContent).toBe("3");

    await ui.unmount();
  });

  it("renders a positive and a negative supplier balance as one grouped, signed string (#254)", async () => {
    // The whole point of #254's acceptance: the number a supplier row shows is
    // pinned, so it cannot drift from the card's direction wording again. The
    // wording itself (which phrase names a supplier receivable) is the owner's
    // open decision and is left exactly as it was.
    weOwe = [
      summary({ kind: "PURCHASE", counterpartyId: "sup-pos", counterpartyName: "مورد موجب", remainingTotal: 0, invoiceCount: 0, accountBalance: 92_500 }),
      summary({ kind: "PURCHASE", counterpartyId: "sup-neg", counterpartyName: "مورد سالب", remainingTotal: 0, invoiceCount: 0, accountBalance: -92_500 }),
    ];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    const rowTotal = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("button[data-testid='debts-person']"))
        .find((button) => button.textContent?.includes(name))
        ?.querySelector<HTMLElement>("[data-testid='debts-person-total']") ?? null;

    // grouped Western digits, and the sign glued to its digits inside the
    // isolated figures run (a sibling sign is what bidi displaced to the far
    // end of the row in the #254 screenshot). The POLARITY is #260's, merged
    // while this PR was in flight: a positive balance is the credit we hold
    // (leading "+"), a negative one is the debt we owe.
    expect(rowTotal("مورد موجب")?.textContent).toBe("+ 92,500 دج");
    expect(rowTotal("مورد موجب")?.querySelector<HTMLElement>('[data-testid="money-figures"]')?.textContent).toBe("+ 92,500");
    expect(rowTotal("مورد سالب")?.textContent).toBe("− 92,500 دج");
    expect(rowTotal("مورد سالب")?.querySelector<HTMLElement>('[data-testid="money-figures"]')?.textContent).toBe("− 92,500");

    await ui.unmount();
  });

  it("labels a supplier group that nets in credit instead of a bare negative total (#180)", async () => {
    owedToUs = [summary({ counterpartyName: "زبون مدين", remainingTotal: 600, invoiceCount: 1 })];
    weOwe = [summary({ kind: "PURCHASE", counterpartyId: "sup-credit", counterpartyName: "مورد دائن", remainingTotal: 0, invoiceCount: 1, accountBalance: 1500 })];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    // the supplier group nets in credit: the dashboard's label and the absolute
    // amount, never a bare negative number
    expect(ui.text()).toContain("رصيد لنا عند الموردين");
    expect(ui.groupTotal("debts-group-weowe")?.textContent).toContain("1,500");
    expect(ui.groupTotal("debts-group-weowe")?.textContent).not.toContain("-");
    // the positive customer group keeps the plain total label
    expect(ui.groupTotal("debts-group-owed")?.textContent).toContain("600");
    expect(ui.text()).toContain("الإجمالي");

    await ui.unmount();
  });

  it("colours a supplier credit positive/green and a supplier debt negative/red (#260)", async () => {
    owedToUs = [];
    weOwe = [
      summary({ kind: "PURCHASE", counterpartyId: "sup-credit", counterpartyName: "مورد دائن", remainingTotal: 0, invoiceCount: 1, accountBalance: 1500 }),
      summary({ kind: "PURCHASE", counterpartyId: "sup-debt", counterpartyName: "مورد مدين", remainingTotal: 0, invoiceCount: 1, accountBalance: -800 }),
    ];
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.personButtons().length === 2)).toBe(true);

    const creditTotal = ui.personNamed("مورد دائن")?.querySelector<HTMLElement>('[data-testid="debts-person-total"]');
    const debtTotal = ui.personNamed("مورد مدين")?.querySelector<HTMLElement>('[data-testid="debts-person-total"]');

    // #260 — credit is positive and green; a debt is negative and red
    expect(creditTotal?.textContent).toContain("+");
    expect(creditTotal?.className).toContain("text-success");
    expect(debtTotal?.textContent).toContain("−");
    expect(debtTotal?.className).toContain("text-destructive");

    await ui.unmount();
  });

  it("keeps the plain total when a supplier group nets to exactly zero (#180)", async () => {
    weOwe = [
      summary({ kind: "PURCHASE", counterpartyId: "sup-a", counterpartyName: "مورد أ", remainingTotal: 0, invoiceCount: 1, accountBalance: -1500 }),
      summary({ kind: "PURCHASE", counterpartyId: "sup-b", counterpartyName: "مورد ب", remainingTotal: 0, invoiceCount: 1, accountBalance: 1500 }),
    ];

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 2);
    expect(loaded).toBe(true);

    // zero is not a credit: the plain total branch renders the absolute value
    expect(ui.groupTotal("debts-group-weowe")?.textContent).toBe("0 دج");
    expect(ui.text()).not.toContain("رصيد لنا عند الموردين");

    await ui.unmount();
  });

  it("shows an empty state per group when nobody owes anything", async () => {
    owedToUs = [];
    weOwe = [];
    const ui = await mountPage(queryClient);
    const appeared = await ui.waitFor(() => ui.emptyOwed() !== null && ui.emptyWeOwe() !== null);
    expect(appeared).toBe(true);

    // each group names the next step and makes it pressable
    expect(ui.emptyOwed()?.textContent).toContain("تظهر هنا الفواتير غير المدفوعة عند الزبائن");
    expect(ui.emptyOwed()?.querySelector("a")?.getAttribute("href")?.split("?")[0]).toBe("/sale");
    expect(ui.emptyWeOwe()?.textContent).toContain("تظهر هنا الفواتير غير المدفوعة عند الموردين");
    expect(ui.emptyWeOwe()?.querySelector("a")?.getAttribute("href")?.split("?")[0]).toBe("/purchase");
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
    expect(cells).toContain("01/08/2026");
    expect(cells).toContain("1,000 دج");
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

  it("distinguishes opposite adjustments in the account movements table (Greptile finding 6)", async () => {
    const PARTY_ID = "00000000-0000-4000-8000-0000000000ce";
    weOwe = [summary({ kind: "PURCHASE", counterpartyId: PARTY_ID, counterpartyName: "مورد تسويات", remainingTotal: 0, invoiceCount: 0, accountBalance: 0 })];
    supplierAccount = {
      balance: 0,
      entries: [
        { id: "e1", supplierId: PARTY_ID, kind: "ADJUSTMENT", amount: 500, direction: "WE_OWE", invoiceId: null, invoiceNumber: null, method: null, note: null, ref: null, occurredAt: "2026-10-01T10:00:00", createdAt: "2026-10-01T10:00:00" },
        { id: "e2", supplierId: PARTY_ID, kind: "ADJUSTMENT", amount: 500, direction: "THEY_OWE", invoiceId: null, invoiceNumber: null, method: null, note: null, ref: null, occurredAt: "2026-10-02T10:00:00", createdAt: "2026-10-02T10:00:00" },
      ],
    };

    const ui = await mountPage(queryClient);
    const loaded = await ui.waitFor(() => ui.personButtons().length === 1);
    expect(loaded).toBe(true);
    await act(async () => {
      ui.personNamed("مورد تسويات")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await ui.waitFor(() => document.querySelector('[data-testid="debts-account-entry-direction"]') !== null);

    const rows = Array.from(document.querySelectorAll('[data-testid="debts-account-entry"]'));
    const pairOf = (index: number) => ({
      direction: rows[index]?.querySelector('[data-testid="debts-account-entry-direction"]')?.textContent ?? "",
      amount: rows[index]?.querySelector('[data-testid="debts-account-entry-amount"]')?.textContent ?? "",
    });
    // #260 — the rendered PAIR is atomic: a WE_OWE row shows يسالنا AND a
    // negative amount; a THEY_OWE row shows نسالوه AND a positive one. Asserting
    // both halves on one row is what makes the atomicity claim testable: revert
    // only the sign (or only the labels) and one half of this pair goes wrong.
    const weOweRow = pairOf(0);
    expect(weOweRow.direction).toContain("يسالنا");
    expect(weOweRow.amount).toContain("−");
    const theyOweRow = pairOf(1);
    expect(theyOweRow.direction).toContain("نسالوه");
    expect(theyOweRow.amount).toContain("+");

    await ui.unmount();
  });
});