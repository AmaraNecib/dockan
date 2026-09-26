import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/**
 * The range label is the only thing under test, so the profit figures stay at
 * their zero baseline; only `range.from`/`range.to` are meaningful fixtures.
 */
interface ProfitReportFixture {
  range: { preset: string; from: string; to: string };
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  ownerWithdrawals: number;
  resultAfterExpenses: number;
  byCategory: Array<{ categoryId: string; categoryName: string; isOwnerWithdrawal: boolean; total: number; count: number }>;
}

let report: ProfitReportFixture;

// The page resolves its single query through orpc.reportsProfit.queryOptions;
// mock the rpc module so the test drives a fixture without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    reportsProfit: {
      // SAFETY: mirror the real tanstack-query utils signature ({ input }) —
      // the page sends { preset, customFrom, customTo }, ignored by the fixture
      queryOptions: ({ input }: { input: unknown }) => ({
        queryKey: ["reportsProfit", input],
        queryFn: async (): Promise<ProfitReportFixture> => report,
      }),
    },
  },
  rpcClient: {},
}));

const { ReportsPage } = await import("./reports");

/** mounts are registered so afterEach tears them down even on assertion failure */
let mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function mountPage(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ReportsPage />
      </QueryClientProvider>,
    );
  });
  return {
    text: () => container.textContent ?? "",
    rangeLabel: () => container.querySelector<HTMLElement>("[data-testid='report-range-label']"),
    /** the LTR-isolated date spans inside the RTL range sentence */
    rangeDates: () =>
      container.querySelectorAll<HTMLElement>("[data-testid='report-range-label'] > span[dir='ltr']"),
    waitFor: async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (check()) return true;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      return false;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      mountedRoots = mountedRoots.filter((entry) => entry.container !== container);
    },
  };
}

function fixture(over: Partial<ProfitReportFixture> = {}): ProfitReportFixture {
  return {
    range: { preset: "CUSTOM", from: "2026-08-01T00:00:00", to: "2026-08-31T23:59:59" },
    revenue: 0,
    cogs: 0,
    grossProfit: 0,
    operatingExpenses: 0,
    ownerWithdrawals: 0,
    resultAfterExpenses: 0,
    byCategory: [],
    ...over,
  };
}

describe("ReportsPage range label (#73)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    document.body.innerHTML = "";
    mountedRoots = [];
    report = fixture();
  });

  afterEach(() => {
    // teardown any mount left behind by a failed assertion — a dangling root
    // would leak DOM (and act() warnings) into the next test in the file
    for (const { root, container } of mountedRoots) {
      root.unmount();
      container.remove();
    }
    mountedRoots = [];
    queryClient.clear();
  });

  it("renders the localized Arabic day range and drops the time-of-day", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rangeLabel() !== null)).toBe(true);

    // day + Arabic month name + year for both bounds, no clock time
    expect(page.rangeLabel()?.textContent).toBe("من 1 أغسطس 2026 إلى 31 أغسطس 2026");
    // the raw ISO moments never leak through
    expect(page.text()).not.toContain("2026-08-01T00:00:00");
    expect(page.text()).not.toContain("2026-08-31T23:59:59");

    await page.unmount();
  });

  it("keeps the range container RTL with each date LTR-isolated", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rangeDates().length === 2)).toBe(true);

    expect(page.rangeLabel()?.getAttribute("dir")).toBe("rtl");

    const dates = page.rangeDates();
    expect(dates).toHaveLength(2);
    for (const date of dates) {
      expect(date.getAttribute("dir")).toBe("ltr");
    }
    expect(dates[0]?.textContent).toBe("1 أغسطس 2026");
    expect(dates[1]?.textContent).toBe("31 أغسطس 2026");

    await page.unmount();
  });
});
