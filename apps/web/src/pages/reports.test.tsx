import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { parseDateTimeText } from "../lib/dates";
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
/** the last input the page sent to reportsProfit, for the custom-bounds specs */
let lastReportInput: { preset?: string; customFrom?: string; customTo?: string } | null = null;

// The page resolves its single query through orpc.reportsProfit.queryOptions;
// mock the rpc module so the test drives a fixture without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    reportsProfit: {
      // SAFETY: mirror the real tanstack-query utils signature ({ input }) —
      // the page sends { preset, customFrom, customTo }, recorded for the
      // custom-bounds specs and otherwise ignored by the fixture
      queryOptions: ({ input }: { input: { preset?: string; customFrom?: string; customTo?: string } }) => {
        lastReportInput = input;
        return {
          queryKey: ["reportsProfit", input],
          queryFn: async (): Promise<ProfitReportFixture> => report,
        };
      },
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
    type: async (testid: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
      if (input === null) throw new Error(`missing ${testid}`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
    click: async (testid: string) => {
      const element = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
      if (element === null) throw new Error(`missing ${testid}`);
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
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

  it("renders the short day-first range and drops the time-of-day", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rangeLabel() !== null)).toBe(true);

    // issue #119: `01/08/2026 — 31/08/2026`, no localized month names, no clock
    expect(page.rangeLabel()?.textContent).toBe("01/08/2026 — 31/08/2026");
    // the raw ISO moments never leak through
    expect(page.text()).not.toContain("2026-08-01T00:00:00");
    expect(page.text()).not.toContain("2026-08-31T23:59:59");
    // nor any machine-locale month name (the old Intl output)
    expect(page.text()).not.toContain("أغسطس");
    expect(page.text()).not.toContain("Aug");

    await page.unmount();
  });

  it("keeps the range label beside the select, nowrap, without forcing direction", async () => {
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rangeLabel() !== null)).toBe(true);

    const label = page.rangeLabel()!;
    // one line: the label itself never wraps
    expect(label.className).toContain("whitespace-nowrap");
    // no dir forcing: in the RTL row the first date reads on the right and the
    // second on its left; no LTR-isolated spans remain
    expect(label.getAttribute("dir")).toBeNull();
    expect(label.querySelectorAll("span[dir='ltr']")).toHaveLength(0);
    // beside the select: same row container holds the range select
    expect(label.parentElement?.querySelector('[data-testid="report-range-preset"]')).not.toBeNull();

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

describe("ReportsPage custom bounds (issue #123)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    document.body.innerHTML = "";
    mountedRoots = [];
    report = fixture();
    lastReportInput = null;
  });

  afterEach(() => {
    for (const { root, container } of mountedRoots) {
      root.unmount();
      container.remove();
    }
    mountedRoots = [];
    queryClient.clear();
  });

  async function openCustomRange(page: Awaited<ReturnType<typeof mountPage>>) {
    const trigger = page.container().querySelector<HTMLButtonElement>('[data-testid="report-range-preset"]');
    if (trigger === null) throw new Error("missing report-range-preset");
    await openSelect(trigger);
    const option = await findOption("فترة مخصصة");
    expect(option).not.toBeNull();
    await activateOption(option!);
    expect(await page.waitFor(() => page.container().querySelector('[data-testid="report-custom-from"]') !== null)).toBe(true);
  }

  it("shows day-first text bounds, never the OS datetime-local control", async () => {
    const page = await mountPage(queryClient);
    await openCustomRange(page);

    const from = page.container().querySelector<HTMLInputElement>('[data-testid="report-custom-from"]');
    const to = page.container().querySelector<HTMLInputElement>('[data-testid="report-custom-to"]');
    expect(from?.type).toBe("text");
    expect(to?.type).toBe("text");
    expect(from?.getAttribute("placeholder")).toBe(i18n.t("expenseDateHint"));

    await page.unmount();
  });

  it("sends the typed day-first bounds as the api's ISO moments", async () => {
    const page = await mountPage(queryClient);
    await openCustomRange(page);

    await page.type("report-custom-from", "01/01/2020 00:00");
    await page.type("report-custom-to", "31/01/2020 23:59");

    expect(await page.waitFor(() => lastReportInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);
    expect(lastReportInput).toMatchObject({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:00" });

    await page.unmount();
  });

  it("refuses an impossible bound visibly and keeps the last applied window", async () => {
    const page = await mountPage(queryClient);
    await openCustomRange(page);

    await page.type("report-custom-from", "01/01/2020 00:00");
    expect(await page.waitFor(() => lastReportInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);

    await page.type("report-custom-from", "31/02/2020 00:00");
    const from = page.container().querySelector<HTMLInputElement>('[data-testid="report-custom-from"]')!;
    await act(async () => {
      from.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(from.getAttribute("aria-invalid")).toBe("true");
    const error = page.container().querySelector<HTMLElement>('[data-testid="report-custom-from-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain(i18n.t("expenseDateInvalid"));
    // the impossible value is not applied; the window keeps its last bound
    expect(lastReportInput?.customFrom).toBe("2020-01-01T00:00:00");

    // correcting the value clears the refusal and applies the new bound
    await page.type("report-custom-from", "02/01/2020 00:00");
    expect(from.getAttribute("aria-invalid")).toBeNull();
    expect(page.container().querySelector('[data-testid="report-custom-from-error"]')).toBeNull();
    expect(await page.waitFor(() => lastReportInput?.customFrom === "2020-01-02T00:00:00")).toBe(true);

    await page.unmount();
  });

  it("fills the upper bound with now from «الآن» and sends it", async () => {
    const page = await mountPage(queryClient);
    await openCustomRange(page);

    await page.type("report-custom-to", "15/01/2026 08:05");
    await page.click("report-custom-to-now");

    const value = page.container().querySelector<HTMLInputElement>('[data-testid="report-custom-to"]')!.value;
    expect(value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(value).not.toBe("15/01/2026 08:05");
    expect(await page.waitFor(() => lastReportInput?.customTo === parseDateTimeText(value))).toBe(true);

    await page.unmount();
  });
});
