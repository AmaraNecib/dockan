import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { activateOption, findOption, openSelect } from "../tests/select-driver";

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
    container: () => container,
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

  it("opens the themed preset select, selects CUSTOM, and closes", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.container().querySelector('[data-testid="report-range-preset"]') !== null)).toBe(true);

    const trigger = page.container().querySelector<HTMLButtonElement>('[data-testid="report-range-preset"]');
    if (trigger === null) throw new Error("missing report-range-preset");
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await openSelect(trigger);
    const option = await findOption("فترة مخصصة");
    expect(option).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await activateOption(option!);
    // popup closes and the trigger shows the chosen label
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("فترة مخصصة");
    // CUSTOM reveals the date bounds
    expect(await page.waitFor(() => page.container().querySelector('[data-testid="report-custom-from"]') !== null)).toBe(true);
    expect(page.container().querySelector('[data-testid="report-custom-to"]')).not.toBeNull();

    await page.unmount();
  });

  it("fills the owner-withdrawal badge solid so a tinted row cannot sink it", async () => {
    report = fixture({
      byCategory: [{ categoryId: "cat-1", categoryName: "سحوبات المالك", isOwnerWithdrawal: true, total: 3000, count: 1 }],
    });
    const page = await mountPage(queryClient);
    const row = '[data-testid="report-breakdown-row"]';
    expect(await page.waitFor(() => page.container().querySelector(row) !== null)).toBe(true);

    const badge = page.container().querySelector<HTMLElement>(`${row} span.rounded`);
    // a /20 tint over the row's own /10 tint measured below 4.5:1 in light mode,
    // so the badge is a solid fill whose foreground pair the contrast test guards
    expect(badge?.className).toContain("bg-warning");
    expect(badge?.className).not.toContain("bg-warning/20");
    expect(badge?.className).toContain("text-warning-foreground");

    await page.unmount();
  });

  it("closes the themed preset select on Escape without changing the value", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.container().querySelector('[data-testid="report-range-preset"]') !== null)).toBe(true);

    const trigger = page.container().querySelector<HTMLButtonElement>('[data-testid="report-range-preset"]');
    if (trigger === null) throw new Error("missing report-range-preset");

    await openSelect(trigger);
    expect(await findOption("فترة مخصصة")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(await page.waitFor(() => trigger.getAttribute("aria-expanded") === "false")).toBe(true);
    // Escape dismisses without committing a new preset
    expect(trigger.textContent).toContain("الشهر الحالي");

    await page.unmount();
  });
});
