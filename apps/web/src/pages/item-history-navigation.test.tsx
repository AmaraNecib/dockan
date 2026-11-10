import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReceiptCostResolution } from "@dokan/contracts";

import "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";
import { routerMock } from "../tests/router-mock";

const itemId = "00000000-0000-4000-8000-000000000467";
const routeSearch: Record<string, string | undefined> = {};
mock.module("@tanstack/react-router", () => routerMock({ itemId }, routeSearch));

interface HistoryFixture {
  item: { id: string; name: string };
  total: number;
  pageOffset?: number;
  stockOnHand: number;
  movements: {
    id: string;
    itemId: string;
    kind: "SALE" | "PURCHASE" | "RETURN_RECORDED" | "MANUAL_ADJUSTMENT";
    delta: number;
    unitCost: number | null;
    reason: string | null;
    ref: string | null;
    returnMark: null;
    occurredAt: string;
    createdAt: string;
    stockAfter: number;
    costPending?: boolean;
    details?: {
      sellingPrice: number | null;
      saleTotal: number | null;
      netSaleTotal: number | null;
      cost: { unitCost: number | null; total: number | null; costPending?: boolean } | null;
      receiptOriginalCost?: { unitCost: number | null; costPending: boolean };
      receiptResolution?: { unitCost: number; reason: string; actorId: string | null; actorName: string | null; recordedAt: string } | null;
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

type HistoryRequest = { itemId: string; focusMovementId?: string; limit?: number; offset?: number };
let historyResult: HistoryFixture;
let historyResultForRequest: ((input: HistoryRequest) => HistoryFixture) | null = null;
let historyPromise: Promise<HistoryFixture> | null = null;
const historyRequests: HistoryRequest[] = [];
let resolutionCalls: Array<{ movementId: string; unitCost: number; reason: string }> = [];
let failResolution = false;

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTML input value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

mock.module("@/lib/rpc", () => ({
  orpc: {
    itemsHistory: {
      queryOptions: ({ input }: { input: HistoryRequest }) => {
        historyRequests.push(input);
        return { queryKey: ["issue467-item-history", input], queryFn: () => historyPromise ?? Promise.resolve(historyResultForRequest?.(input) ?? historyResult) };
      },
    },
    receiptCostsResolve: {
      mutationOptions: (options: { onSuccess?: (record: ReceiptCostResolution) => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["receiptCostsResolve"],
        ...options,
        mutationFn: async (input: { movementId: string; unitCost: number; reason: string }) => {
          resolutionCalls.push(input);
          if (failResolution) { failResolution = false; throw new Error("RECEIPT_RESOLUTION_CONFLICT"); }
          const resolution = { id: "resolution-1", ...input, actorId: "owner-1", actorName: "Owner", recordedAt: "2026-11-10T12:00:00", created: true, adjustments: [] };
          historyResult = { ...historyResult, movements: historyResult.movements.map((movement) => {
            if (movement.id !== input.movementId) return movement;
            const previousDetails = movement.details ?? { sellingPrice: null, saleTotal: null, netSaleTotal: null, cost: null, documents: [] };
            return {
              ...movement,
              unitCost: input.unitCost,
              costPending: false,
              details: { ...previousDetails, cost: { unitCost: input.unitCost, total: movement.delta * input.unitCost, costPending: false }, receiptResolution: { unitCost: input.unitCost, reason: input.reason, actorId: "owner-1", actorName: "Owner", recordedAt: resolution.recordedAt } },
            };
          }) };
          return resolution;
        },
      }),
    },
  },
  rpcClient: {},
}));

const { ItemHistoryPage } = await import("./stock");

describe("item-history navigation and disclosure (issue #467)", () => {
  beforeEach(() => {
    delete routeSearch.focusMovementId;
    historyRequests.length = 0;
    historyResultForRequest = null;
    historyPromise = null;
    resolutionCalls = [];
    failResolution = false;
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

  it("requests a focused movement beyond page one, updates the pager, and opens only that row", async () => {
    const focusedMovementId = "00000000-0000-4000-8000-000000000999";
    routeSearch.focusMovementId = focusedMovementId;
    historyResult = {
      ...historyResult,
      total: 50,
      pageOffset: 20,
      movements: Array.from({ length: 10 }, (_, index) => sale(
        index === 9 ? focusedMovementId : `movement-page-2-${index}`,
        documentA,
        `INV-467-${index}`,
        -1,
      )),
    };

    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "focused history table");

    expect(historyRequests.some((input) => input.itemId === itemId && input.focusMovementId === focusedMovementId)).toBe(true);
    expect(historyRequests.some((input) => input.offset === 20 && input.focusMovementId === focusedMovementId)).toBe(true);
    expect(page.query("history-pager-page-3")?.getAttribute("aria-current")).toBe("page");
    expect(page.query(`history-movement-row-${focusedMovementId}`)?.getAttribute("data-focused")).toBe("true");
    expect(page.query(`history-toggle-${focusedMovementId}`)?.getAttribute("aria-expanded")).toBe("true");
    const expandedRows = [...page.container.querySelectorAll<HTMLButtonElement>('button[data-testid^="history-toggle-"]')]
      .filter((button) => button.getAttribute("aria-expanded") === "true");
    expect(expandedRows.map((button) => button.dataset.testid)).toEqual([`history-toggle-${focusedMovementId}`]);
    const highlightedRows = [...page.container.querySelectorAll('[data-focused="true"]')];
    expect(highlightedRows.map((row) => row.getAttribute("data-testid"))).toEqual([`history-movement-row-${focusedMovementId}`]);
  });

  it("focused receipt then click page1 stays on page 1 after refetch", async () => {
    const focusedMovementId = "00000000-0000-4000-8000-000000000999";
    routeSearch.focusMovementId = focusedMovementId;
    const pageThree: HistoryFixture = {
      ...historyResult,
      total: 50,
      pageOffset: 20,
      movements: Array.from({ length: 10 }, (_, index) => sale(
        index === 9 ? focusedMovementId : `movement-page-3-${index}`,
        documentA,
        `INV-467-${index}`,
        -1,
      )),
    };
    const pageOne: HistoryFixture = {
      ...historyResult,
      total: 50,
      pageOffset: 0,
      movements: Array.from({ length: 10 }, (_, index) => sale(
        `movement-page-1-${index}`,
        documentA,
        `INV-467-FIRST-${index}`,
        -1,
      )),
    };
    historyResultForRequest = (input) => input.focusMovementId === focusedMovementId ? pageThree : pageOne;

    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query(`history-movement-row-${focusedMovementId}`) !== null, "focused receipt on page 3");
    expect(page.query("history-pager-page-3")?.getAttribute("aria-current")).toBe("page");

    await act(async () => page.query<HTMLButtonElement>("history-pager-page-1")?.click());
    await page.poll(() => page.query("history-pager-page-1")?.getAttribute("aria-current") === "page", "page 1 after selection");
    expect(page.query("history-focus-unavailable")).toBeNull();
    expect(historyRequests.some((input) => input.offset === 0 && input.focusMovementId === undefined)).toBe(true);

    const requestsBeforeRefetch = historyRequests.length;
    await act(async () => {
      await page.queryClient.invalidateQueries({ queryKey: ["issue467-item-history"] });
    });
    expect(historyRequests.length).toBeGreaterThan(requestsBeforeRefetch);
    expect(page.query("history-pager-page-1")?.getAttribute("aria-current")).toBe("page");
    expect(page.query("history-focus-unavailable")).toBeNull();
    expect(historyRequests.at(-1)).toMatchObject({ offset: 0, itemId });
    expect(historyRequests.at(-1)?.focusMovementId).toBeUndefined();
  });

  it("reports a missing or other-item focus without expanding another movement", async () => {
    routeSearch.focusMovementId = "00000000-0000-4000-8000-000000000998";
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-focus-unavailable") !== null, "unavailable focus status");

    expect(historyRequests.some((input) => input.focusMovementId === routeSearch.focusMovementId)).toBe(true);
    expect(page.query("history-focus-unavailable")?.textContent).toContain("غير متاحة");
    expect([...page.container.querySelectorAll<HTMLButtonElement>('button[data-testid^="history-toggle-"]')]
      .every((button) => button.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(page.container.querySelectorAll('[data-focused="true"]')).toHaveLength(0);
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
    expect(page.query("history-selling-price-movement-a")?.previousElementSibling?.textContent).toBe("سعر البيع (دج)");
    expect(page.query("history-sale-total-movement-a")?.textContent).toContain("1,800");
    expect(page.query("history-cost-total-movement-a")?.textContent).toContain("800");

    await act(async () => firstToggle.click());
    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(page.query("history-detail-row-movement-a")?.hasAttribute("hidden")).toBe(true);
    expect(secondToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("places the neutral native values explanation after the amount list", async () => {
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history table");
    await act(async () => page.query<HTMLButtonElement>("history-toggle-movement-a")?.click());

    const amountSection = page.query("history-fact-selling-price-movement-a")?.parentElement?.parentElement;
    const amounts = amountSection?.querySelector("dl");
    const help = amountSection?.querySelector<HTMLDetailsElement>('[data-testid="history-facts-help"]');
    const summary = help?.querySelector("summary");
    expect(amountSection?.querySelector("h3")?.textContent).toBe("القيم المسجلة للحركة");
    expect(amounts).not.toBeNull();
    expect(help).not.toBeNull();
    expect(amounts?.nextElementSibling).toBe(help);
    expect(help?.open).toBe(false);
    expect(summary?.textContent?.trim()).toBe("توضيح القيم");
    expect(summary?.className).toContain("min-h-11");
    expect(summary?.className).not.toMatch(/text-primary|underline/);
    const hint = "الأسعار والتكاليف كما سُجلت وقت الحركة، لا أسعار اليوم. قد تغيب القيم القديمة وتكون تكلفة الوحدة مقربة. إجمالي التكلفة يخص وحدات هذه الحركة لا إجمالي البيع؛ إذا لم يُسجل، يبقى غير متوفر ولا يُستنتج من تكلفة الوحدة المقربة أو تكلفة اليوم.";
    expect(help?.querySelector("p")?.textContent).toBe(hint);

    await act(async () => summary?.click());
    expect(help?.open).toBe(true);
    expect(help?.querySelector("p")?.textContent).toBe(hint);
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

  it("resolves a pending receipt from its own history without changing the original posting facts", async () => {
    historyResult = {
      ...historyResult,
      total: 1,
      movements: [{
        id: "pending-receipt", itemId, kind: "PURCHASE", delta: 5, unitCost: null, costPending: true, reason: null, ref: null,
        returnMark: null, occurredAt: "2026-10-10T09:00:00", createdAt: "2026-10-10T09:01:00", stockAfter: 5,
        details: { sellingPrice: 900, saleTotal: null, netSaleTotal: null, cost: { unitCost: null, total: null, costPending: true }, receiptOriginalCost: { unitCost: null, costPending: true }, receiptResolution: null, documents: [] },
      }],
    };
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "pending receipt history");
    await act(async () => page.query<HTMLButtonElement>("history-toggle-pending-receipt")?.click());
    const open = page.query<HTMLButtonElement>("receipt-resolution-open-pending-receipt");
    expect(open).not.toBeNull();
    await act(async () => open?.click());
    expect(page.query("history-detail-pending-receipt")?.textContent).toContain("تكلفة هذا الوارد ما زالت معلّقة");
    expect(page.query("history-detail-pending-receipt")?.textContent).toContain("2026");

    const cost = page.query<HTMLInputElement>("receipt-resolution-cost");
    const reason = page.query<HTMLInputElement>("receipt-resolution-reason");
    expect(cost).not.toBeNull();
    expect(reason).not.toBeNull();
    if (cost === null || reason === null) return;
    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-save")?.click());
    expect(document.activeElement).toBe(cost);
    expect(page.query("receipt-resolution-error")?.textContent).toContain("أدخل تكلفة وحدة صحيحة");
    await act(async () => {
      setInputValue(cost, "0");
    });
    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-save")?.click());
    expect(document.activeElement).toBe(reason);
    expect(page.query("receipt-resolution-error")?.textContent).toContain("اكتب سبب معرفة التكلفة");
    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-cancel")?.click());
    expect(resolutionCalls).toHaveLength(0);
  });

  it("offers receipt resolution only on the original purchase, before and after its resolution", async () => {
    const purchase = {
      id: "pending-receipt", itemId, kind: "PURCHASE" as const, delta: 5, unitCost: null, costPending: true, reason: null, ref: null,
      returnMark: null, occurredAt: "2026-10-10T09:00:00", createdAt: "2026-10-10T09:01:00", stockAfter: 5,
      details: { sellingPrice: 900, saleTotal: null, netSaleTotal: null, cost: { unitCost: null, total: null, costPending: true }, receiptOriginalCost: { unitCost: null, costPending: true }, receiptResolution: null, documents: [] },
    };
    const returnedLayer = { ...purchase, id: "returned-layer", kind: "RETURN_RECORDED" as const, delta: 1 };
    historyResult = { ...historyResult, total: 2, movements: [purchase, returnedLayer] };
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "pending receipt history");
    await act(async () => {
      page.query<HTMLButtonElement>("history-toggle-pending-receipt")?.click();
      page.query<HTMLButtonElement>("history-toggle-returned-layer")?.click();
    });
    expect(page.query("receipt-resolution-open-pending-receipt")).not.toBeNull();
    expect(page.query("receipt-resolution-returned-layer")).toBeNull();
    historyResult = { ...historyResult, movements: [{ ...purchase, details: { ...purchase.details, receiptResolution: { unitCost: 100, reason: "confirmed", actorId: "owner-1", actorName: "Owner", recordedAt: "2026-10-11T09:00:00" } } }, returnedLayer] };
    await act(async () => { await page.queryClient.invalidateQueries({ queryKey: ["issue467-item-history"] }); });
    await page.poll(() => page.query("receipt-resolution-open-pending-receipt") === null, "resolved receipt action to disappear");
    expect(page.query("receipt-resolution-open-pending-receipt")).toBeNull();
    expect(page.query("receipt-resolution-returned-layer")).toBeNull();
    expect(page.query("receipt-resolution-audit-pending-receipt")).not.toBeNull();
  });

  it("keeps receipt identity and draft after a failed write, then shows the immutable audit on retry", async () => {
    failResolution = true;
    historyResult = {
      ...historyResult,
      total: 1,
      movements: [{
        id: "pending-receipt", itemId, kind: "PURCHASE", delta: 5, unitCost: null, costPending: true, reason: null, ref: null,
        returnMark: null, occurredAt: "2026-10-10T09:00:00", createdAt: "2026-10-10T09:01:00", stockAfter: 5,
        details: { sellingPrice: 900, saleTotal: null, netSaleTotal: null, cost: { unitCost: null, total: null, costPending: true }, receiptOriginalCost: { unitCost: null, costPending: true }, receiptResolution: null, documents: [] },
      }],
    };
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "pending receipt history");
    await act(async () => page.query<HTMLButtonElement>("history-toggle-pending-receipt")?.click());
    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-open-pending-receipt")?.click());
    const cost = page.query<HTMLInputElement>("receipt-resolution-cost");
    const reason = page.query<HTMLInputElement>("receipt-resolution-reason");
    if (cost === null || reason === null) throw new Error("Receipt resolution inputs did not render");
    await act(async () => { setInputValue(cost, "100"); setInputValue(reason, "supplier receipt confirmed"); });
    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-save")?.click());
    await page.poll(() => page.query("receipt-resolution-error") !== null, "write refusal");
    expect(cost.value).toBe("100");
    expect(reason.value).toBe("supplier receipt confirmed");
    expect(page.query("receipt-resolution-error")?.textContent).toContain("سُجّلت تكلفة مختلفة");

    await act(async () => page.query<HTMLButtonElement>("receipt-resolution-save")?.click());
    await page.poll(() => page.query("receipt-resolution-audit-pending-receipt") !== null, "resolution audit");
    expect(resolutionCalls).toEqual([
      { movementId: "pending-receipt", unitCost: 100, reason: "supplier receipt confirmed" },
      { movementId: "pending-receipt", unitCost: 100, reason: "supplier receipt confirmed" },
    ]);
    const audit = page.query("receipt-resolution-audit-pending-receipt");
    expect(audit?.textContent).toContain("التكلفة المسجلة عند الاستلام");
    expect(audit?.textContent).toContain("التكلفة الفعلية بعد التصحيح");
    expect(audit?.textContent).toContain("Owner");
    expect(audit?.textContent).toContain("supplier receipt confirmed");
    expect(page.query("history-detail-pending-receipt")?.textContent).toContain("وقت تسجيل التصحيح");
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
