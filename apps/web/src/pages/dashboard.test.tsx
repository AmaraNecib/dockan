import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import i18n from "i18next";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as routerModule from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import { ONBOARDING_COMPLETED_KEY, ONBOARDING_DISMISSED_KEY } from "../components/app/onboarding-state";

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

type OnboardingProgress = {
  hasItems: boolean;
  hasPurchase: boolean;
  hasSale: boolean;
  hasDebt: boolean;
};

let summary: DashboardSummary;
let progress: OnboardingProgress;
let preferenceStore: Record<string, string>;
let failSummary = false;
let failProgress = false;
let failPreferences = false;
let failPreferenceWrites = false;
let preferenceWriteCalls = 0;
let preferenceWriteGate: Promise<void> | null = null;
let preferencesPending = false;
let progressPending = false;
let failAcknowledge = false;
let acknowledgeCount = 0;
let fetchCount = 0;
let progressFetchCount = 0;

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
// (Link as a plain anchor + useParams). Spread the real module so sibling test
// files that need RouterProvider keep it no matter which file runs first.
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  Link: (props: { children?: ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; search?: boolean; to?: string }) => {
    const { children, params, search, to, ...rest } = props;
    // the mock renders a plain anchor; a router `search` flag has no DOM form
    void search;
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
    onboardingProgress: {
      queryOptions: () => ({
        queryKey: ["onboardingProgress"],
        queryFn: async () => {
          progressFetchCount += 1;
          if (failProgress) throw new Error("ONBOARDING_PROGRESS_FAILED");
          if (progressPending) return new Promise<never>(() => {});
          return progress;
        },
      }),
    },
    onboardingComplete: {
      mutationOptions: (opts?: { onSuccess?: () => void }) => ({
        mutationFn: async () => {
          acknowledgeCount += 1;
          if (failAcknowledge) throw new Error("ONBOARDING_COMPLETE_FAILED");
          preferenceStore[ONBOARDING_COMPLETED_KEY] = "true";
          return { completed: true };
        },
        ...opts,
      }),
    },
  },
  rpcClient: {
    preferencesGet: async () => {
      if (failPreferences) throw new Error("PREFERENCES_READ_FAILED");
      if (preferencesPending) return new Promise<never>(() => {});
      return { values: { ...preferenceStore } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      preferenceWriteCalls += 1;
      if (failPreferenceWrites) throw new Error("PREFERENCES_WRITE_FAILED");
      if (preferenceWriteGate !== null) {
        const gate = preferenceWriteGate;
        preferenceWriteGate = null;
        await gate;
      }
      preferenceStore[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
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
    panel: () => container.querySelector<HTMLElement>("[data-testid='getting-started']"),
    panelSkeleton: () => container.querySelector<HTMLElement>("[data-testid='getting-started-skeleton']"),
    steps: () => Array.from(container.querySelectorAll<HTMLElement>("[data-testid='getting-started-step']")),
    dismiss: () => container.querySelector<HTMLButtonElement>("[data-testid='getting-started-dismiss']"),
    error: () => container.querySelector<HTMLElement>("[data-testid='dashboard-error']"),
    dismissFailed: () => container.querySelector<HTMLElement>("[data-testid='getting-started-dismiss-error']"),
    stale: () => container.querySelector<HTMLElement>("[data-testid='dashboard-stale']"),
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
    failProgress = false;
    failPreferences = false;
    failPreferenceWrites = false;
    preferenceWriteCalls = 0;
    preferenceWriteGate = null;
    preferencesPending = false;
    progressPending = false;
    failAcknowledge = false;
    acknowledgeCount = 0;
    fetchCount = 0;
    progressFetchCount = 0;
    preferenceStore = {};
    progress = { hasItems: false, hasPurchase: false, hasSale: false, hasDebt: false };
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

  it("tells the owner when a dismissal did not save", async () => {
    failPreferenceWrites = true;
    progress = { hasItems: false, hasPurchase: false, hasSale: false, hasDebt: false };
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);

    await act(async () => page.dismiss()?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // the control snapping back with no explanation is the bug
    expect(page.dismissFailed()).not.toBeNull();
    // let the failed write settle before the next test shares the harness
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await page.unmount();
  });

  it("stops re-issuing the completion milestone after repeated failures", async () => {
    // every progress observation would otherwise re-issue the write for as long
    // as the tab stays open
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    failAcknowledge = true;
    const page = await mount(queryClient);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["onboardingProgress"] });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    }
    expect(acknowledgeCount).toBeGreaterThan(0);

    // let the last attempt's retries land, then the cap is reached for good
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const settled = acknowledgeCount;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["onboardingProgress"] });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    }
    expect(acknowledgeCount).toBe(settled);
    // let the last attempt's retries land before the next test shares the harness
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await page.unmount();
  });

  it("renders the server's own day in the app's day-first shape, not a device-derived one", async () => {
    summary.day = "2026-08-31";
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    // issue #119: day-first display, still the server's calendar day
    expect(page.card("dashboard-day")?.textContent).toBe("31/08/2026");
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

  it("teaches the next step when there are no recent invoices", async () => {
    summary.recentInvoices = [];
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-recents-empty") !== null)).toBe(true);

    const empty = page.card("dashboard-recents-empty");
    expect(empty?.textContent).toContain(i18n.t("dashboardRecentsEmptyHint"));
    expect(empty?.querySelector("a")?.getAttribute("href")?.split("?")[0]).toBe("/sale");
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

  it("keeps the last good figures and flags them stale when a background refetch fails", async () => {
    const page = await mount(queryClient, { refreshMs: 20 }); // 20ms refresh keeps the test fast
    expect(await waitFor(() => page.card("dashboard-sales-today")?.textContent?.includes("7500") ?? false)).toBe(true);
    expect(page.stale()).toBeNull();

    failSummary = true;
    expect(await waitFor(() => page.stale() !== null)).toBe(true);
    expect(page.stale()?.getAttribute("role")).toBe("status");
    expect(page.stale()?.textContent).toContain(i18n.t("dashboardStaleRefresh"));
    expect(page.card("dashboard-sales-today")?.textContent).toContain("7500");
    expect(page.error()).toBeNull();
    await page.unmount();
  });

  it("refetches the summary on the refresh interval", async () => {
    const page = await mount(queryClient, { refreshMs: 20 }); // 20ms refresh keeps the test fast
    expect(await waitFor(() => fetchCount >= 2)).toBe(true);
    await page.unmount();
  });
});

describe("GettingStartedPanel on the dashboard (issue #97)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    failSummary = false;
    failProgress = false;
    failPreferences = false;
    failPreferenceWrites = false;
    preferenceWriteCalls = 0;
    preferenceWriteGate = null;
    preferencesPending = false;
    progressPending = false;
    failAcknowledge = false;
    acknowledgeCount = 0;
    fetchCount = 0;
    progressFetchCount = 0;
    preferenceStore = {};
    progress = { hasItems: false, hasPurchase: false, hasSale: false, hasDebt: false };
    summary = {
      day: "2026-08-31",
      salesTotal: 0,
      salesCount: 0,
      owedToUs: 0,
      weOwe: 0,
      lowStockCount: 0,
      lowStockItems: [],
      recentInvoices: [],
    };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  /** A client with no cached preferences/progress, to prove server persistence. */
  function freshClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }

  it("shows the four steps in shop order, each a real link to its screen", async () => {
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);

    const steps = page.steps();
    expect(steps).toHaveLength(4);
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining(i18n.t("onboardingStepItems")),
      expect.stringContaining(i18n.t("onboardingStepPurchase")),
      expect.stringContaining(i18n.t("onboardingStepSale")),
      expect.stringContaining(i18n.t("onboardingStepDebts")),
    ]);
    expect(steps.map((step) => step.querySelector("a")?.getAttribute("href")?.split("?")[0])).toEqual([
      "/items",
      "/purchase",
      "/sale",
      "/debts",
    ]);
    // a real heading, not an eyebrow above one
    expect(page.panel()?.querySelector("h2")?.textContent).toBe(i18n.t("onboardingTitle"));
    // an ordered list, not a card grid
    expect(page.panel()?.querySelector("ol")).not.toBeNull();
    // labelled section + non-colour-only completion text for assistive tech
    expect(page.panel()?.getAttribute("aria-labelledby")).toBe("getting-started-title");
    expect(steps[0]?.textContent).toContain(i18n.t("onboardingPending"));
    expect(page.dismiss()?.getAttribute("aria-label")).toBe(i18n.t("onboardingDismissLabel"));
    // sits right under the page heading, above the quick actions
    const pageRoot = page.card("dashboard-page");
    expect(pageRoot?.querySelector("h1")?.nextElementSibling).toBe(page.panel());
    expect(page.panel()?.nextElementSibling?.querySelector("[data-testid='dashboard-new-sale']")).not.toBeNull();
    await page.unmount();
  });

  it("marks a step done from the server record and leaves the next pending", async () => {
    progress = { hasItems: true, hasPurchase: false, hasSale: false, hasDebt: false };
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);

    expect(page.steps()[0]?.getAttribute("data-state")).toBe("done");
    expect(page.steps()[1]?.getAttribute("data-state")).toBe("pending");
    expect(page.steps()[0]?.textContent).toContain(i18n.t("onboardingDone"));
    expect(page.steps()[1]?.textContent).toContain(i18n.t("onboardingPending"));
    await page.unmount();
  });

  it("never renders once every step is complete", async () => {
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    expect(page.panel()).toBeNull();
    await page.unmount();
  });

  it("records the completed milestone server-side when every step is complete", async () => {
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const page = await mount(queryClient);
    // the server owns the milestone; the client only asks for it
    expect(await waitFor(() => preferenceStore[ONBOARDING_COMPLETED_KEY] === "true")).toBe(true);
    expect(acknowledgeCount).toBeGreaterThan(0);
    expect(page.panel()).toBeNull();
    await page.unmount();
  });

  it("does not claim completion the server rejected", async () => {
    failAcknowledge = true;
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const page = await mount(queryClient);
    expect(await waitFor(() => acknowledgeCount > 0)).toBe(true);
    // the live records already hide the panel, but no persisted milestone exists
    expect(preferenceStore[ONBOARDING_COMPLETED_KEY]).toBeUndefined();
    expect(page.panel()).toBeNull();
    await page.unmount();
  });

  it("retries the milestone on a later observation after a failure", async () => {
    failAcknowledge = true;
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const page = await mount(queryClient, { refreshMs: 20 });
    // each progress refetch is a new observation, so the failed record retries
    expect(await waitFor(() => acknowledgeCount >= 3)).toBe(true);

    failAcknowledge = false;
    expect(await waitFor(() => preferenceStore[ONBOARDING_COMPLETED_KEY] === "true")).toBe(true);
    await page.unmount();
  });

  it("does not return after completion, even if records later change", async () => {
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const page = await mount(queryClient);
    // the milestone is written once the whole checklist is observed complete
    expect(await waitFor(() => preferenceStore[ONBOARDING_COMPLETED_KEY] === "true")).toBe(true);
    expect(page.panel()).toBeNull();
    await page.unmount();

    // a later settlement removes the debt record; the graduated panel stays gone
    progress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: false };
    const remountClient = freshClient();
    const remounted = await mount(remountClient);
    expect(await waitFor(() => remounted.card("dashboard-day") !== null)).toBe(true);
    expect(remounted.panel()).toBeNull();
    remountClient.clear();
    await remounted.unmount();
  });

  it("dismisses the panel and remembers the choice across a remount", async () => {
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);
    await act(async () => page.dismiss()?.click());
    // the preferences cache update is batched by React Query, so wait for it
    expect(await waitFor(() => page.panel() === null)).toBe(true);
    expect(preferenceStore[ONBOARDING_DISMISSED_KEY]).toBe("true");
    await page.unmount();

    const remountClient = freshClient();
    const remounted = await mount(remountClient);
    expect(await waitFor(() => remounted.card("dashboard-day") !== null)).toBe(true);
    expect(remounted.panel()).toBeNull();
    remountClient.clear();
    await remounted.unmount();
  });

  it("leaves the panel visible when the dismissal write fails", async () => {
    failPreferenceWrites = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);

    await act(async () => page.dismiss()?.click());
    // the write ran, no optimistic hide: the panel stays visible
    expect(await waitFor(() => preferenceWriteCalls >= 1)).toBe(true);
    expect(page.panel()).not.toBeNull();
    expect(preferenceStore[ONBOARDING_DISMISSED_KEY]).toBeUndefined();
    await page.unmount();
  });

  it("disables the dismiss control while the write is in flight", async () => {
    let releaseWrite = () => {};
    preferenceWriteGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);

    await act(async () => page.dismiss()?.click());
    expect(await waitFor(() => page.dismiss()?.disabled === true)).toBe(true);

    releaseWrite();
    expect(await waitFor(() => page.panel() === null)).toBe(true);
    expect(preferenceStore[ONBOARDING_DISMISSED_KEY]).toBe("true");
    await page.unmount();
  });

  it("leaves the existing cards and lists visible alongside the panel", async () => {
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);
    expect(await waitFor(() => page.card("dashboard-sales-today") !== null)).toBe(true);
    expect(page.card("dashboard-debt-owed")).not.toBeNull();
    expect(page.card("dashboard-recents-empty")).not.toBeNull();
    await page.unmount();
  });

  it("shows a loading skeleton while the progress read is pending", async () => {
    progressPending = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panelSkeleton() !== null)).toBe(true);
    expect(page.panelSkeleton()?.getAttribute("aria-hidden")).toBe("true");
    expect(page.panel()).toBeNull();
    await page.unmount();
  });

  it("hides the panel when the progress read fails without touching the figures", async () => {
    failProgress = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-sales-today") !== null)).toBe(true);
    // the failure propagates a tick after the summary lands, so wait it out
    expect(await waitFor(() => page.panel() === null && page.panelSkeleton() === null)).toBe(true);
    expect(page.card("dashboard-debt-owed")).not.toBeNull();
    await page.unmount();
  });

  it("still shows the panel when the summary read fails", async () => {
    failSummary = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.panel() !== null)).toBe(true);
    expect(await waitFor(() => page.error() !== null)).toBe(true);
    await page.unmount();
  });

  it("shows no skeleton when the panel is already dismissed", async () => {
    preferenceStore[ONBOARDING_DISMISSED_KEY] = "true";
    progressPending = true;
    const page = await mount(queryClient);
    await flush();
    expect(page.panel()).toBeNull();
    expect(page.panelSkeleton()).toBeNull();
    await page.unmount();
  });

  it("does not show the panel when the preference read fails", async () => {
    // "we could not ask" is not "not dismissed": defaulting to visible re-nags
    // an owner who already dismissed it
    failPreferences = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    await flush();
    await flush();
    expect(page.panel()).toBeNull();
    await page.unmount();
  });

  it("does not read progress at all once the panel is dismissed", async () => {
    preferenceStore[ONBOARDING_DISMISSED_KEY] = "true";
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    await flush();
    await flush();
    expect(progressFetchCount).toBe(0);
    await page.unmount();
  });

  it("does not read progress while the preferences are still loading", async () => {
    preferencesPending = true;
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    await flush();
    await flush();
    expect(progressFetchCount).toBe(0);
    // no skeleton either: an owner who dismissed must not see a flash
    expect(page.panel()).toBeNull();
    expect(page.panelSkeleton()).toBeNull();
    await page.unmount();
  });

  it("does not read progress at all once the checklist is complete", async () => {
    preferenceStore[ONBOARDING_COMPLETED_KEY] = "true";
    const page = await mount(queryClient);
    expect(await waitFor(() => page.card("dashboard-day") !== null)).toBe(true);
    await flush();
    await flush();
    expect(progressFetchCount).toBe(0);
    await page.unmount();
  });

  it("refetches progress on the refresh interval", async () => {
    const page = await mount(queryClient, { refreshMs: 20 });
    expect(await waitFor(() => progressFetchCount >= 2)).toBe(true);
    await page.unmount();
  });
});
