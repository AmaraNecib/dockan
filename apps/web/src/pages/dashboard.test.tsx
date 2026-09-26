import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import i18n from "i18next";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

type Invoice = {
  id: string;
  invoiceNumber: string;
  kind: "SALE" | "PURCHASE";
  counterpartyId: string | null;
  counterpartyName: string | null;
  invoiceDate: string;
  createdAt: string;
  totalAmount: number;
  remainingAmount: number;
};

type ListInput = { kind?: "SALE" | "PURCHASE"; fromDate?: string; toDate?: string };
/** Only the fields the dashboard's today-sales query sends. */
type SalesInput = { kind: "SALE"; fromDate?: string; toDate?: string };
type DebtRow = { remainingTotal: number };

let salesInputs: SalesInput[] = [];
let allInvoices: Invoice[] = [];
let owedToUs: DebtRow[] = [];
let weOwe: DebtRow[] = [];
let lowStockItems: { id: string; name: string; stockOnHand: number; lowStockThreshold: number }[] = [];
let failLowStock = false;
/** Mirrors the api's 200-row invoicesList cap so the disclosure is testable. */
let invoiceRowCap = 200;

function invoice(over: Partial<Invoice>): Invoice {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    kind: "SALE",
    counterpartyId: null,
    counterpartyName: null,
    invoiceDate: "2026-08-31",
    createdAt: "2026-08-31T10:00:00",
    totalAmount: 0,
    remainingAmount: 0,
    ...over,
  };
}

// Link normally needs a router tree; mirror the seam the other page tests use
// (Link as a plain anchor + useParams) so the mock stays compatible with the
// sibling test files that share this monkey-patched module.
mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return (
      <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>
        {children}
      </a>
    );
  },
  useParams: () => ({}),
}));

// The page resolves every query through orpc.*.queryOptions; mock the rpc
// module so fixtures drive the render without a network seam. The invoicesList
// mock honours the requested date window and the api's business-date ordering,
// so the page's range and its client-side re-sort are both exercised.
mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesList: {
      queryOptions: ({ input }: { input?: ListInput } = {}) => ({
        queryKey: ["invoicesList", input],
        queryFn: async () => {
          if (input?.kind === "SALE") {
            salesInputs.push({ kind: "SALE", fromDate: input.fromDate, toDate: input.toDate });
            const sameDay = allInvoices.filter(
              (inv) =>
                inv.kind === "SALE" &&
                (input.fromDate === undefined || inv.invoiceDate >= input.fromDate) &&
                (input.toDate === undefined || inv.invoiceDate <= input.toDate),
            );
            return { items: sameDay.slice(0, invoiceRowCap), totalCount: sameDay.length };
          }
          // api order: business date first (newest date), then creation time.
          const ordered = [...allInvoices].sort(
            (a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.createdAt.localeCompare(a.createdAt),
          );
          return { items: ordered.slice(0, invoiceRowCap), totalCount: ordered.length };
        },
      }),
    },
    reportsDebts: {
      queryOptions: () => ({
        queryKey: ["reportsDebts"],
        queryFn: async () => ({ owedToUs, weOwe }),
      }),
    },
    itemsLowStock: {
      queryOptions: () => ({
        queryKey: ["itemsLowStock"],
        queryFn: async () => {
          if (failLowStock) throw new Error("ITEMS_LOW_STOCK_FAILED");
          return { items: lowStockItems };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { DashboardPage, algeriaLocalDate } = await import("./dashboard");

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (check()) return true;
    await flush();
  }
  return false;
}

async function mount(queryClient: QueryClient, opts: { dayTickMs?: number; refreshMs?: number } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardPage dayTickMs={opts.dayTickMs} refreshMs={opts.refreshMs} />
      </QueryClientProvider>,
    );
  });
  return {
    card: (testId: string) => container.querySelector<HTMLElement>(`[data-testid='${testId}']`),
    rows: () => Array.from(container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='dashboard-recent-row']")),
    skeletons: () => container.querySelectorAll("[data-slot='skeleton']"),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("DashboardPage KPIs", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    salesInputs = [];
    allInvoices = [];
    owedToUs = [];
    weOwe = [];
    lowStockItems = [];
    failLowStock = false;
    invoiceRowCap = 200;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    setSystemTime();
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("sums only SALE invoices inside the requested Algeria-local day", async () => {
    setSystemTime(new Date("2026-08-31T12:00:00Z")); // 13:00 in Algiers, 2026-08-31
    allInvoices = [
      invoice({ id: "a", invoiceNumber: "INV-0001", invoiceDate: "2026-08-31", createdAt: "2026-08-31T09:00:00", totalAmount: 5_000 }),
      invoice({ id: "b", invoiceNumber: "INV-0002", invoiceDate: "2026-08-31", createdAt: "2026-08-31T10:00:00", totalAmount: 2_500, remainingAmount: 2_500 }),
      invoice({ id: "yesterday", invoiceNumber: "INV-0003", invoiceDate: "2026-08-30", createdAt: "2026-08-30T10:00:00", totalAmount: 9_999 }),
      invoice({ id: "purchase", invoiceNumber: "INV-0004", kind: "PURCHASE", invoiceDate: "2026-08-31", createdAt: "2026-08-31T11:00:00", totalAmount: 8_888 }),
    ];

    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-sales-today")?.textContent?.includes("7500") ?? false)).toBe(true);

    const sales = page.card("dashboard-sales-today")?.textContent ?? "";
    expect(sales).toContain("7500");
    expect(sales).not.toContain("9999"); // yesterday's SALE is outside the day
    expect(sales).not.toContain("8888"); // today's PURCHASE is not a sale
    expect(salesInputs.at(-1)).toMatchObject({ fromDate: "2026-08-31", toDate: "2026-08-31" });
    await page.unmount();
  });

  it("shows total money owed to the shop with the we-owe subline", async () => {
    owedToUs = [{ remainingTotal: 4_000 }, { remainingTotal: 3_000 }];
    weOwe = [{ remainingTotal: 1_200 }];

    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-debt-owed")?.textContent?.includes("7000") ?? false)).toBe(true);

    const debt = page.card("dashboard-debt-owed")?.textContent ?? "";
    expect(debt).toContain("7000"); // owed to us = 4000 + 3000
    expect(debt).toContain("1200"); // we-owe subline
    await page.unmount();
  });

  it("lists the newest entries by creation time, not the api's business-date order", async () => {
    // api order would show INV-9001 (future-dated, created long ago) first and
    // omit the just-entered backdated INV-9002; the client re-sort fixes that.
    allInvoices = [
      invoice({ id: "future", invoiceNumber: "INV-9001", invoiceDate: "2026-09-05", createdAt: "2026-08-01T09:00:00", totalAmount: 100 }),
      invoice({ id: "backdated", invoiceNumber: "INV-9002", invoiceDate: "2026-08-20", createdAt: "2026-08-31T12:00:00", totalAmount: 200 }),
      invoice({ id: "middle", invoiceNumber: "INV-9003", invoiceDate: "2026-08-25", createdAt: "2026-08-25T09:00:00", totalAmount: 300 }),
    ];

    const page = await mount(queryClient);
    expect(await waitFor(() => page.rows().length === 3)).toBe(true);

    const order = page.rows().map((row) => row.querySelector("td")?.textContent?.trim());
    expect(order).toEqual(["INV-9002", "INV-9003", "INV-9001"]);
    await page.unmount();
  });

  it("flags the sales figure as a floor when totalCount exceeds the returned rows", async () => {
    setSystemTime(new Date("2026-08-31T12:00:00Z"));
    invoiceRowCap = 1; // simulate the 200-row cap with a small number
    allInvoices = [
      invoice({ id: "a", invoiceNumber: "INV-0001", invoiceDate: "2026-08-31", createdAt: "2026-08-31T09:00:00", totalAmount: 5_000 }),
      invoice({ id: "b", invoiceNumber: "INV-0002", invoiceDate: "2026-08-31", createdAt: "2026-08-31T10:00:00", totalAmount: 2_500 }),
    ];

    const cappedCopy = i18n.t("dashboardSalesCapped");
    const page = await mount(queryClient);
    expect(await waitFor(() => (page.card("dashboard-sales-today")?.textContent ?? "").includes(cappedCopy))).toBe(true);

    const sales = page.card("dashboard-sales-today")?.textContent ?? "";
    expect(sales).toContain("5000"); // only the returned row is summed
    expect(sales).toContain(cappedCopy);
    await page.unmount();
  });

  it("refetches the landing figures on the refresh interval", async () => {
    const page = await mount(queryClient, { refreshMs: 20 }); // 20ms refresh keeps the test fast
    expect(await waitFor(() => salesInputs.length >= 2)).toBe(true);
    await page.unmount();
  });

  it("resolves the Algeria-local date at the day and year boundaries", () => {
    // Africa/Algiers is UTC+1 with no DST.
    expect(algeriaLocalDate(new Date("2026-08-31T22:59:59Z"))).toBe("2026-08-31"); // 23:59:59 local
    expect(algeriaLocalDate(new Date("2026-08-31T23:00:00Z"))).toBe("2026-09-01"); // 00:00:00 local
    expect(algeriaLocalDate(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01"); // year rollover
  });

  it("queries the current local day and rolls the window over at midnight", async () => {
    setSystemTime(new Date("2026-08-31T22:59:30Z")); // 23:59:30 in Algiers

    const page = await mount(queryClient, { dayTickMs: 20 }); // 20ms day tick keeps the test fast
    // Settle every query first, so below the only thing that can re-render the
    // page is the day tick — an incidental re-render must not fake the rollover.
    expect(await waitFor(() => page.skeletons().length === 0)).toBe(true);
    expect(await waitFor(() => salesInputs.some((input) => input.fromDate === "2026-08-31"))).toBe(true);
    const fetchesBeforeMidnight = salesInputs.length;

    // cross midnight in Algiers; the next tick must move the query window
    setSystemTime(new Date("2026-08-31T23:00:30Z"));
    expect(await waitFor(() => salesInputs.some((input) => input.fromDate === "2026-09-01"))).toBe(true);
    expect(salesInputs.length).toBeGreaterThan(fetchesBeforeMidnight);
    await page.unmount();
  });

  it("degrades a failed low-stock query to a placeholder instead of endless skeletons", async () => {
    failLowStock = true;

    const page = await mount(queryClient);
    // On the buggy branch the low-stock skeleton rows never clear, so waiting
    // for zero skeletons fails; every settled query on the fixed page clears.
    expect(await waitFor(() => page.skeletons().length === 0)).toBe(true);
    expect(page.card("dashboard-low-stock")?.textContent).toContain("—");
    await page.unmount();
  });
});
