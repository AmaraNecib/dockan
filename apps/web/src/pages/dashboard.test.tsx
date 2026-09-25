import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
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
  totalAmount: number;
  remainingAmount: number;
};

/** Only the fields the dashboard's today-sales query sends. */
type SalesInput = { kind: "SALE"; fromDate: string; toDate: string };

let salesInputs: SalesInput[] = [];
let saleInvoices: Invoice[] = [];
let recentInvoices: Invoice[] = [];
let lowStockItems: { id: string; name: string; stockOnHand: number; lowStockThreshold: number }[] = [];
let failLowStock = false;

function invoice(over: Partial<Invoice>): Invoice {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    kind: "SALE",
    counterpartyId: null,
    counterpartyName: null,
    invoiceDate: "2026-08-31",
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
// module so fixtures drive the render without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesList: {
      queryOptions: ({ input }: { input?: { kind?: "SALE" | "PURCHASE" } } = {}) => ({
        queryKey: ["invoicesList", input],
        queryFn: async () => {
          if (input?.kind === "SALE") {
            salesInputs.push(input as SalesInput);
            return { items: saleInvoices, totalCount: saleInvoices.length };
          }
          return { items: recentInvoices, totalCount: recentInvoices.length };
        },
      }),
    },
    reportsDebts: {
      queryOptions: () => ({
        queryKey: ["reportsDebts"],
        queryFn: async () => ({ owedToUs: [], weOwe: [] }),
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

async function mount(queryClient: QueryClient, dayTickMs?: number) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardPage dayTickMs={dayTickMs} />
      </QueryClientProvider>,
    );
  });
  return {
    card: (testId: string) => container.querySelector<HTMLElement>(`[data-testid='${testId}']`),
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
    saleInvoices = [];
    recentInvoices = [];
    lowStockItems = [];
    failLowStock = false;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    setSystemTime();
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("renders today's sales as the sum of the day's SALE invoice totals", async () => {
    saleInvoices = [
      invoice({ id: "a", invoiceNumber: "INV-0001", totalAmount: 5_000 }),
      invoice({ id: "b", invoiceNumber: "INV-0002", totalAmount: 2_500, remainingAmount: 2_500 }),
    ];
    recentInvoices = saleInvoices;

    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-sales-today")?.textContent?.includes("7500") ?? false)).toBe(true);

    expect(page.card("dashboard-sales-today")?.textContent).toContain("7500");
    expect(page.card("dashboard-sales-today")?.textContent).toContain("دج");
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

    const page = await mount(queryClient, 20); // 20ms day tick keeps the test fast
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
