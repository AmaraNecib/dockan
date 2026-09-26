import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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

type DashboardSummary = {
  day: string;
  salesTotal: number;
  salesCount: number;
  owedToUs: number;
  weOwe: number;
  lowStockCount: number | null;
  lowStockItems: { id: string; name: string; stockOnHand: number; lowStockThreshold: number }[] | null;
  recentInvoices: Invoice[] | null;
};

let summary: DashboardSummary;
let failSummary = false;
let fetchCount = 0;

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

// The page now consumes exactly one server aggregate (issue 84); the mock hands
// it a finished payload so the test asserts projection, never client maths.
mock.module("@/lib/rpc", () => ({
  orpc: {
    dashboardSummary: {
      queryOptions: () => ({
        queryKey: ["dashboardSummary"],
        queryFn: async () => {
          fetchCount += 1;
          if (failSummary) throw new Error("DASHBOARD_SUMMARY_FAILED");
          return summary;
        },
      }),
    },
  },
  rpcClient: {},
}));

const { DashboardPage } = await import("./dashboard");

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

async function mount(queryClient: QueryClient, opts: { refreshMs?: number } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardPage refreshMs={opts.refreshMs} />
      </QueryClientProvider>,
    );
  });
  return {
    card: (testId: string) => container.querySelector<HTMLElement>(`[data-testid='${testId}']`),
    rows: () => Array.from(container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='dashboard-recent-row']")),
    error: () => container.querySelector<HTMLElement>("[data-testid='dashboard-error']"),
    skeletons: () => container.querySelectorAll("[data-slot='skeleton']"),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("DashboardPage summary (issue 84)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    failSummary = false;
    fetchCount = 0;
    summary = {
      day: "2026-08-31",
      salesTotal: 7_500,
      salesCount: 2,
      owedToUs: 7_000,
      weOwe: 1_200,
      lowStockCount: 1,
      lowStockItems: [{ id: "i1", name: "بطارية", stockOnHand: 0, lowStockThreshold: 5 }],
      recentInvoices: [invoice({ id: "r1", invoiceNumber: "INV-0009", totalAmount: 5_000, remainingAmount: 2_000 })],
    };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("renders the server's own day, not a device-derived one", async () => {
    summary.day = "2026-08-31";
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    expect(page.card("dashboard-day")?.textContent).toBe("2026-08-31");
    await page.unmount();
  });

  it("renders the server totals and count without client-side maths", async () => {
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-sales-today")?.textContent?.includes("7500") ?? false)).toBe(true);

    const sales = page.card("dashboard-sales-today")?.textContent ?? "";
    expect(sales).toContain("7500");
    expect(sales).toContain(`${i18n.t("dashboardSalesCount")}: 2`);

    const debt = page.card("dashboard-debt-owed")?.textContent ?? "";
    expect(debt).toContain("7000"); // owed to us
    expect(debt).toContain("1200"); // we-owe subline

    expect(page.card("dashboard-low-stock")?.textContent).toContain("1");
    expect(page.card("dashboard-low-stock-list")?.textContent).toContain("0 / 5");
    await page.unmount();
  });

  it("shows a failed section as unavailable without hiding the figures", async () => {
    // null is "this read failed", which must look different from an empty shop
    summary.lowStockCount = null;
    summary.lowStockItems = null;
    summary.recentInvoices = null;

    const page = await mount(queryClient);

    // the money figures still render: one failing section must not blank them
    expect(await waitFor(() => page.card("dashboard-sales-today")?.textContent?.includes("7500") ?? false)).toBe(true);
    expect(page.card("dashboard-debt-owed")?.textContent).toContain("7000");

    // and each failed section says so rather than reading as zero or empty
    expect(page.card("dashboard-low-stock")?.textContent).toContain(i18n.t("dashboardSectionUnavailable"));
    expect(page.card("dashboard-low-stock-unavailable")?.textContent).toBe(i18n.t("dashboardSectionUnavailable"));
    expect(page.card("dashboard-recents-unavailable")?.textContent).toBe(i18n.t("dashboardSectionUnavailable"));

    await page.unmount();
  });

  it("renders the recent invoices in the server's newest-by-creation order", async () => {
    // The server already ordered these newest-created-first; the page must be a
    // pure projection and NOT re-sort them.
    summary.recentInvoices = [
      invoice({ id: "b", invoiceNumber: "INV-0002", invoiceDate: "2026-08-20", createdAt: "2026-08-31T12:00:00" }),
      invoice({ id: "a", invoiceNumber: "INV-0001", invoiceDate: "2026-09-05", createdAt: "2026-08-01T09:00:00" }),
    ];

    const page = await mount(queryClient);
    expect(await waitFor(() => page.rows().length === 2)).toBe(true);

    const order = page.rows().map((row) => row.querySelector("td")?.textContent?.trim());
    expect(order).toEqual(["INV-0002", "INV-0001"]);
    await page.unmount();
  });

  it("shows a neutral failure state (no skeletons) when the summary query fails", async () => {
    failSummary = true;

    const page = await mount(queryClient);
    expect(await waitFor(() => page.error() !== null)).toBe(true);
    expect(page.error()?.getAttribute("role")).toBe("alert");
    expect(page.error()?.textContent).toContain(i18n.t("dashboardError"));
    expect(page.skeletons().length).toBe(0);
    await page.unmount();
  });

  it("refetches the summary on the refresh interval", async () => {
    const page = await mount(queryClient, { refreshMs: 20 }); // 20ms refresh keeps the test fast
    expect(await waitFor(() => fetchCount >= 2)).toBe(true);
    await page.unmount();
  });
});
