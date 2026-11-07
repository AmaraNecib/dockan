import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";
import { routerMock } from "../tests/router-mock";

const itemId = "00000000-0000-4000-8000-000000000467";
mock.module("@tanstack/react-router", () => routerMock({ itemId }));

interface HistoryFixture {
  item: { id: string; name: string };
  total: number;
  stockOnHand: number;
  movements: {
    id: string;
    itemId: string;
    kind: "SALE" | "PURCHASE" | "MANUAL_ADJUSTMENT";
    delta: number;
    unitCost: number | null;
    reason: string | null;
    ref: string | null;
    returnMark: null;
    occurredAt: string;
    createdAt: string;
    stockAfter: number;
    details?: {
      sellingPrice: number | null;
      saleTotal: number | null;
      netSaleTotal: number | null;
      cost: { unitCost: number | null; total: number | null } | null;
      documents: { id: string; number: string }[];
    };
  }[];
}

const documentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const documentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sale(id: string, documentId: string, number: string, delta: number) {
  return {
    id,
    itemId,
    kind: "SALE" as const,
    delta,
    unitCost: 400,
    reason: null,
    ref: documentId,
    returnMark: null,
    occurredAt: "2026-10-15T10:00:00",
    createdAt: "2026-10-15T10:01:00",
    stockAfter: 12 + delta,
    details: {
      sellingPrice: 900,
      saleTotal: 1800,
      netSaleTotal: 1700,
      cost: { unitCost: 400, total: 800 },
      documents: [{ id: documentId, number }, ...(id === "movement-a" ? [{ id: documentB, number: "INV-467-A-2" }] : [])],
    },
  };
}

let historyResult: HistoryFixture;
let historyPromise: Promise<HistoryFixture> | null = null;

mock.module("@/lib/rpc", () => ({
  orpc: {
    itemsHistory: {
      queryOptions: () => ({ queryKey: ["issue467-item-history"], queryFn: () => historyPromise ?? Promise.resolve(historyResult) }),
    },
  },
  rpcClient: {},
}));

const { ItemHistoryPage } = await import("./stock");

describe("item-history navigation and disclosure (issue #467)", () => {
  beforeEach(() => {
    historyPromise = null;
    historyResult = {
      item: { id: itemId, name: "بطارية طويلة الاسم للاختبار" },
      total: 2,
      stockOnHand: 8,
      movements: [sale("movement-a", documentA, "INV-467-A", -2), sale("movement-b", documentB, "INV-467-B", -2)],
    };
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await unmountAllMountedPages();
    document.body.innerHTML = "";
  });

  it("shows accessible identity and table-shaped placeholders only for the initial load", async () => {
    let resolveHistory!: (result: HistoryFixture) => void;
    historyPromise = new Promise((resolve) => { resolveHistory = resolve; });
    const page = await mountWithProviders(<ItemHistoryPage />);

    const status = page.container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent ?? "").toContain("جارٍ تحميل سجل المنتج");
    expect(page.container.querySelector('[data-testid="history-loading"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(page.container.querySelectorAll('[data-testid="history-loading"] [data-slot="skeleton"]').length).toBeGreaterThan(5);
    expect(page.container.querySelector('[data-testid="history-loading"] [data-slot="skeleton"]')?.className).toContain("motion-reduce:animate-none");
    expect(page.query("history-table")).toBeNull();

    historyPromise = null;
    await act(async () => resolveHistory(historyResult));
    await page.poll(() => page.query("history-table") !== null, "loaded history table");

    let resolveRefetch!: (result: HistoryFixture) => void;
    historyPromise = new Promise((resolve) => { resolveRefetch = resolve; });
    await act(async () => {
      void page.queryClient.invalidateQueries({ queryKey: ["issue467-item-history"] });
      await Promise.resolve();
    });
    expect(page.query("history-table")).not.toBeNull();
    expect(page.container.querySelector('[data-testid="history-loading"]')).toBeNull();
    expect(page.container.querySelector("h1")?.textContent).toContain("بطارية طويلة الاسم للاختبار");

    historyPromise = null;
    await act(async () => resolveRefetch(historyResult));
  });

  it("keeps the item identity visible and links the breadcrumb to Products", async () => {
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history table");

    expect(page.container.querySelector("h1")?.textContent).toContain("بطارية طويلة الاسم للاختبار");
    const productsLink = [...page.container.querySelectorAll("nav a")].find((link) => link.textContent?.trim() === "المنتجات");
    expect(productsLink?.getAttribute("href")).toContain("/items");
    expect(page.container.querySelector('nav [aria-current="page"]')?.textContent).toContain("بطارية طويلة الاسم للاختبار");
    expect(page.container.querySelector("h1")?.nextElementSibling?.textContent).toBe("سجل المنتج");
  });

  it("opens multiple full-width details and keeps each set of facts with its movement after reorder", async () => {
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history table");

    const firstToggle = page.query<HTMLButtonElement>("history-toggle-movement-a");
    const secondToggle = page.query<HTMLButtonElement>("history-toggle-movement-b");
    expect(firstToggle).not.toBeNull();
    expect(secondToggle).not.toBeNull();
    if (firstToggle === null || secondToggle === null) return;
    await act(async () => {
      firstToggle.click();
      secondToggle.click();
    });

    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
    expect(secondToggle.getAttribute("aria-expanded")).toBe("true");
    expect(firstToggle.getAttribute("aria-controls")).toBe("history-detail-movement-a");
    expect(secondToggle.getAttribute("aria-controls")).toBe("history-detail-movement-b");
    expect(page.query("history-detail-movement-a")?.textContent).toContain("INV-467-A");
    expect(page.query("history-detail-movement-b")?.textContent).toContain("INV-467-B");

    historyResult = {
      ...historyResult,
      movements: [...historyResult.movements].reverse(),
    };
    await act(async () => {
      await page.queryClient.invalidateQueries({ queryKey: ["issue467-item-history"] });
    });

    expect(page.query("history-toggle-movement-a")?.getAttribute("aria-expanded")).toBe("true");
    expect(page.query("history-toggle-movement-b")?.getAttribute("aria-expanded")).toBe("true");
    expect(page.query("history-detail-movement-a")?.textContent).toContain("INV-467-A");
    expect(page.query("history-detail-movement-b")?.textContent).toContain("INV-467-B");
    expect(page.query("history-detail-row-movement-a")?.previousElementSibling?.getAttribute("data-testid")).toBe("history-movement-row-movement-a");
    expect(page.query("history-selling-price-movement-a")?.textContent).toContain("900");
    expect(page.query("history-sale-total-movement-a")?.textContent).toContain("1,800");
    expect(page.query("history-cost-total-movement-a")?.textContent).toContain("800");

    await act(async () => firstToggle.click());
    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(page.query("history-detail-row-movement-a")?.hasAttribute("hidden")).toBe(true);
    expect(secondToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("labels missing historical amounts as unavailable instead of inventing values", async () => {
    const original = sale("movement-a", documentA, "INV-467-A", -2);
    historyResult = {
      ...historyResult,
      total: 1,
      movements: [{ ...original, unitCost: null, details: {
        sellingPrice: null,
        saleTotal: null,
        netSaleTotal: null,
        cost: null,
        documents: [],
      } }],
    };
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history table");
    const toggle = page.query<HTMLButtonElement>("history-toggle-movement-a");
    expect(toggle).not.toBeNull();
    if (toggle === null) return;
    await act(async () => toggle.click());

    const detail = page.query("history-detail-movement-a");
    expect(detail?.textContent?.match(/غير متوفر في السجل/g)).toHaveLength(5);
    expect(page.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("uses focusable native disclosure buttons with an exact invoice destination per movement", async () => {
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history table");

    const firstToggle = page.query<HTMLButtonElement>("history-toggle-movement-a");
    expect(firstToggle).not.toBeNull();
    if (firstToggle === null) return;
    expect(firstToggle.tagName).toBe("BUTTON");
    expect(firstToggle.type).toBe("button");
    expect(firstToggle.tabIndex).toBe(0);
    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => firstToggle.click());
    const firstDocuments = page.container.querySelectorAll<HTMLAnchorElement>('[data-testid="history-document-movement-a"]');
    const secondDocuments = page.container.querySelectorAll<HTMLAnchorElement>('[data-testid="history-document-movement-b"]');
    expect([...firstDocuments].map((link) => link.getAttribute("href"))).toEqual([
      `/invoices/$invoiceId?invoiceId=${documentA}`,
      `/invoices/$invoiceId?invoiceId=${documentB}`,
    ]);
    expect(secondDocuments).toHaveLength(1);
    expect(page.query("history-detail-row-movement-b")?.hasAttribute("hidden")).toBe(true);

    const secondToggle = page.query<HTMLButtonElement>("history-toggle-movement-b");
    expect(secondToggle).not.toBeNull();
    if (secondToggle === null) return;
    await act(async () => secondToggle.click());
    expect(page.query("history-detail-row-movement-b")?.hasAttribute("hidden")).toBe(false);
    expect(page.container.querySelector<HTMLAnchorElement>('[data-testid="history-document-movement-b"]')?.getAttribute("href")).toContain(`/invoices/$invoiceId?invoiceId=${documentB}`);
  });
});
