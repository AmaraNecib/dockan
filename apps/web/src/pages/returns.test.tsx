import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { ReturnDetail } from "@dokan/contracts";

let failReview = false;
let lastReviewAction: { kind: "accept" | "reject"; returnId: string; reason?: string } | null = null;

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
    activitiesList: { queryKey: () => ["activitiesList"] },
    invoicesList: { queryKey: () => ["invoicesList"] },
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

const { ReturnsReviewList } = await import("./returns");

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
    expect(host.querySelector('[data-testid="returns-list-empty"]')).toBeTruthy();
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
    expect(row.textContent).toContain("1700 دج");
    expect(host.querySelector('[data-testid="returns-print-RTN-0001"]')).toBeTruthy();
  });
});