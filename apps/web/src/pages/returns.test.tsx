import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";

import type { ReturnDetail, SupplierReturnRecord } from "@dokan/contracts";

let failReview = false;
let lastReviewAction: { kind: "accept" | "reject"; returnId: string; reason?: string } | null = null;
/** mutable supplier-returns fixture so the empty / non-empty / error branches are all reachable */
function supplierReturnsPage(items: SupplierReturnRecord[], total: number) {
  return { items, total };
}
let supplierReturns = supplierReturnsPage([], 0);
let supplierReturnsFails = false;

mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: import("react").ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>{children}</a>;
  },
  useParams: () => ({}),
}));

mock.module("@/lib/rpc", () => ({
  orpc: {
    returnsList: { queryKey: ({ input }: { input?: { invoiceId?: string } }) => ["returnsList", input ?? {}] },
    returnsPendingCount: { queryKey: () => ["returnsPendingCount"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
    invoicesList: { queryKey: () => ["invoicesList"] },
    suppliersReturnsList: {
      queryOptions: () => ({
        queryKey: ["suppliersReturnsList"],
        queryFn: async () => {
          if (supplierReturnsFails) throw new Error("boom");
          return supplierReturns;
        },
      }),
    },
    returnsAccept: {
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsAccept"],
        ...options,
        mutationFn: async (input: { returnId: string }) => {
          lastReviewAction = { kind: "accept", returnId: input.returnId };
          if (failReview) throw new Error("RETURN_NOT_PENDING");
          return { ok: true };
        },
      }),
    },
    returnsReject: {
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsReject"],
        ...options,
        mutationFn: async (input: { returnId: string; reason?: string }) => {
          lastReviewAction = { kind: "reject", returnId: input.returnId, reason: input.reason };
          if (failReview) throw new Error("RETURN_NOT_PENDING");
          return { ok: true };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { ReturnsReviewList, SupplierReturnsList } = await import("./returns");

function makeReturn(status: ReturnDetail["status"], overrides: Partial<ReturnDetail> = {}): ReturnDetail {
  return {
    id: `00000000-0000-4000-8000-${status === "PENDING_REVIEW" ? "0000000000e1" : "0000000000e2"}`,
    returnNumber: status === "PENDING_REVIEW" ? "RTN-0001" : "RTN-0002",
    invoiceId: "00000000-0000-4000-8000-0000000000f1",
    invoiceNumber: "INV-0010",
    invoiceDate: "2026-08-26",
    counterpartyName: "يوسف",
    refundAmount: 1700,
    cashPaidOut: 1700,
    debtOffset: 0,
    debtApplied: 0,
    spreadsAcrossInvoices: false,
    payoutMethod: "CASH",
    reason: null,
    status,
    occurredAt: "2026-08-26T10:30:00",
    createdAt: "2026-08-26T10:30:00",
    updatedAt: "2026-08-26T10:30:00",
    lines: [
      {
        id: "00000000-0000-4000-8000-0000000000f2",
        returnId: "00000000-0000-4000-8000-0000000000e1",
        invoiceLineId: "00000000-0000-4000-8000-0000000000f3",
        itemId: "00000000-0000-4000-8000-0000000000f4",
        description: "بطارية",
        quantity: 2,
        refundUnitPrice: 850,
        refundAmount: 1700,
      },
    ],
    ...overrides,
  };
}

let roots: Array<{ unmount: () => void }> = [];
let host = document.createElement("div");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  failReview = false;
  lastReviewAction = null;
  supplierReturns = supplierReturnsPage([], 0);
  supplierReturnsFails = false;
});

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  host.remove();
});

function renderList(returns: readonly ReturnDetail[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ReturnsReviewList returns={returns} />
      </QueryClientProvider>,
    );
  });
}

function typeInto(input: HTMLInputElement, text: string) {
  // SAFETY: every input in the panel is an HTMLInputElement with the value setter
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("ReturnsReviewList (accept / reject review flow)", () => {
  it("shows the empty state when no returns exist", () => {
    renderList([]);
    const empty = host.querySelector('[data-testid="returns-list-empty"]');
    expect(empty).toBeTruthy();
    // issue #96 — a read-only review list explains where returns come from
    expect(empty?.textContent).toContain(i18n.t("returnsEmpty"));
    expect(empty?.textContent).toContain(i18n.t("returnsEmptyHint"));
    // and it invents no action
    expect(empty?.querySelector("button, a")).toBeNull();
  });

  it("does not show the empty state once a return exists", () => {
    renderList([makeReturn("ACCEPTED")]);
    expect(host.querySelector('[data-testid="returns-list-empty"]')).toBeNull();
  });

  it("renders an accepted return without review buttons and with its green status", () => {
    renderList([makeReturn("ACCEPTED")]);
    expect(host.querySelector('[data-testid="returns-review-RTN-0002"]')?.textContent).toContain("مقبول");
    expect(host.querySelector('[data-testid="returns-actions-RTN-0002"]')).toBeNull();
    expect(host.querySelector('[data-testid="returns-print-RTN-0002"]')).toBeTruthy();
  });

  it("accepts a pending return and sends exactly the return id", async () => {
    renderList([makeReturn("PENDING_REVIEW")]);
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="returns-accept-RTN-0001"]')!.click();
    });
    await flushAsync();
    expect(lastReviewAction).toMatchObject({ kind: "accept", returnId: "00000000-0000-4000-8000-0000000000e1" });
  });

  it("rejects a pending return with the typed note", async () => {
    renderList([makeReturn("PENDING_REVIEW")]);
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-reject-reason-RTN-0001"]')!, "كسر في العبوة");
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="returns-reject-RTN-0001"]')!.click();
    });
    await flushAsync();
    expect(lastReviewAction).toMatchObject({ kind: "reject", reason: "كسر في العبوة" });
  });

  it("surfaces the server refusal when a stale review races the api", async () => {
    renderList([makeReturn("PENDING_REVIEW")]);
    failReview = true;
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="returns-accept-RTN-0001"]')!.click();
    });
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-review-error"]')?.textContent).toContain("المرجوع سبق أن قُورض");
  });

  it("shows the pending (amber) status chip and the voucher link on a pending row", () => {
    renderList([makeReturn("PENDING_REVIEW")]);
    const row = host.querySelector('[data-testid="returns-review-RTN-0001"]')!;
    expect(row.textContent).toContain("قيد المراجعة");
    expect(row.textContent).toContain("1,700 دج");
    expect(host.querySelector('[data-testid="returns-print-RTN-0001"]')).toBeTruthy();
  });

  it("labels the debt portion by review state (#68): pending reads as on-acceptance", () => {
    renderList([makeReturn("PENDING_REVIEW", { debtOffset: 300, cashPaidOut: 1400 })]);
    const row = host.querySelector('[data-testid="returns-review-RTN-0001"]')!;
    // the pending card must not claim the deduction is already applied
    expect(row.textContent).toContain("خصم من الدين (عند القبول)");
    expect(row.textContent).toContain("300 دج");
  });

  it("labels an accepted return with the APPLIED amount and a rejected one as not applied (#68)", () => {
    // the accepted card must show debtApplied (what acceptance really relieved,
    // possibly less than the recorded debtOffset after the accept-time cap)
    renderList([
      makeReturn("ACCEPTED", { returnNumber: "RTN-0002", debtOffset: 400, debtApplied: 250, cashPaidOut: 1300 }),
      makeReturn("REJECTED_DAMAGED", { returnNumber: "RTN-0003", debtOffset: 400, cashPaidOut: 1300 }),
    ]);
    const accepted = host.querySelector('[data-testid="returns-review-RTN-0002"]')!;
    const rejected = host.querySelector('[data-testid="returns-review-RTN-0003"]')!;
    expect(accepted.textContent).toContain("خصم من الدين (مطبّق)");
    expect(accepted.textContent).toContain("250 دج");
    expect(accepted.textContent).not.toContain("400 دج");
    expect(rejected.textContent).toContain("خصم من الدين (لم يُطبّق)");
  });
});

describe("SupplierReturnsList (issue #96)", () => {
  function renderSupplierReturns() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <SupplierReturnsList />
        </QueryClientProvider>,
      );
    });
  }

  it("explains where supplier returns come from", async () => {
    renderSupplierReturns();
    await flushAsync();

    const empty = host.querySelector('[data-testid="supplier-returns-empty"]');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain(i18n.t("supplierReturnsEmpty"));
    expect(empty?.textContent).toContain(i18n.t("supplierReturnsEmptyHint"));
    // no invented action on a read-only list
    expect(empty?.querySelector("button, a")).toBeNull();
  });

  it("shows the list, not the empty state, once a supplier return exists", async () => {
    const record: SupplierReturnRecord = {
      id: "sr-1",
      returnNumber: "PRT-0001",
      supplierId: "sup-1",
      supplierName: "مورد",
      invoiceId: null,
      invoiceNumber: null,
      kind: "FREE_STANDING",
      amount: 500,
      debtReduction: 0,
      credit: 500,
      cashBack: 0,
      reason: null,
      occurredAt: "2026-08-26T10:00:00",
      createdAt: "2026-08-26T10:00:00",
      lines: [],
    };
    supplierReturns = supplierReturnsPage([record], 1);
    renderSupplierReturns();
    await flushAsync();

    expect(host.querySelector('[data-testid="supplier-returns-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="supplier-returns-list"]')).toBeTruthy();
  });

  it("shows the error box, not the empty state, when the read fails", async () => {
    supplierReturnsFails = true;
    renderSupplierReturns();
    await flushAsync();

    expect(host.querySelector('[data-testid="supplier-returns-error"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="supplier-returns-empty"]')).toBeNull();
  });
});
