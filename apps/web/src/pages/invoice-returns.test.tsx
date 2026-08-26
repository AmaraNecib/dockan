import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { InvoiceDetail, ReturnDetail } from "@dokan/contracts";

/** returnsList payload the panel should serve, or an error flag / payload for create */
let returnsData: ReturnDetail[] = [];
let failReturnsCreate = false;
let lastCreateInput: { invoiceId: string; lines: Array<{ invoiceLineId: string; quantity: number }>; reason?: string; cashPaidOut?: number } | null = null;

// The page module imports the rpc client and the router Link at module scope;
// stub the whole seam + Link (rendered as a plain anchor) so the panel is
// testable without a network or a router mount.
mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: import("react").ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>{children}</a>;
  },
  useParams: () => ({}),
}));

mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesGet: {
      queryKey: ({ input }: { input: { id: string } }) => ["invoicesGet", input],
    },
    invoicesList: { queryKey: () => ["invoicesList"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
    returnsList: {
      queryOptions: () => ({
        queryKey: ["returnsList"],
        queryFn: async () => ({ items: returnsData }),
      }),
      queryKey: ({ input }: { input: { invoiceId: string } }) => ["returnsList", input],
    },
    returnsCreate: {
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsCreate"],
        ...options,
        mutationFn: async (input: { invoiceId: string; lines: Array<{ invoiceLineId: string; quantity: number }>; reason?: string }) => {
          lastCreateInput = input;
          if (failReturnsCreate) throw new Error("RETURN_EXCEEDS_RETURNABLE");
          return { items: [] };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { returnQuantityError, remainingReturnableFor, ReturnsPanel } = await import("./invoice");

const LINE_ID = "00000000-0000-4000-8000-0000000000c1";
const ITEM_ID = "00000000-0000-4000-8000-0000000000c2";

function makeInvoice(lines: InvoiceDetail["lines"] = [], paidAmount = 900, totalAmount = 900): InvoiceDetail {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    invoiceNumber: "INV-0001",
    kind: "SALE",
    counterpartyId: null,
    counterpartyName: "زبون",
    invoiceDate: "2026-08-26",
    subtotalAmount: 900,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount,
    paidAmount,
    remainingAmount: Math.max(0, totalAmount - paidAmount),
    notes: null,
    createdAt: "2026-08-26T10:00:00",
    updatedAt: "2026-08-26T10:00:00",
    lines,
    payments: [],
  };
}

function saleLine(overrides: Partial<InvoiceDetail["lines"][number]> = {}): InvoiceDetail["lines"][number] {
  return {
    id: LINE_ID,
    invoiceId: "00000000-0000-4000-8000-0000000000b1",
    itemId: ITEM_ID,
    description: "بطارية",
    quantity: 4,
    defaultUnitPrice: 900,
    unitPrice: 900,
    costAtSale: 400,
    cogsExact: 1600,
    total: 3600,
    discountAllocated: 0,
    netTotal: 3600,
    ...overrides,
  };
}

function returnRecord(overrides: Partial<ReturnDetail> = {}): ReturnDetail {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    returnNumber: "RTN-0001",
    invoiceId: "00000000-0000-4000-8000-0000000000b1",
    invoiceNumber: "INV-0001",
    invoiceDate: "2026-08-26",
    counterpartyName: "زبون",
    refundAmount: 900,
    cashPaidOut: 900,
    debtOffset: 0,
    payoutMethod: "CASH",
    reason: null,
    status: "PENDING_REVIEW",
    occurredAt: "2026-08-26T10:30:00",
    createdAt: "2026-08-26T10:30:00",
    updatedAt: "2026-08-26T10:30:00",
    lines: [
      {
        id: "00000000-0000-4000-8000-0000000000d2",
        returnId: "00000000-0000-4000-8000-0000000000d1",
        invoiceLineId: LINE_ID,
        itemId: ITEM_ID,
        description: "بطارية",
        quantity: 1,
        refundUnitPrice: 900,
        refundAmount: 900,
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
  returnsData = [];
  failReturnsCreate = false;
  lastCreateInput = null;
});

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  host.remove();
});

function renderPanel(invoice: InvoiceDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ReturnsPanel invoice={invoice} />
      </QueryClientProvider>,
    );
  });
}

/** Sets a controlled input through the native setter + input event so React's
 * onChange fires (plain .value assignment is ignored by React's tracker). */
function typeInto(input: HTMLInputElement, text: string) {
  // SAFETY: every input in the panel is an HTMLInputElement with the value setter
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("returnQuantityError (per-line return cap boundary)", () => {
  it("treats an untouched (empty) line as not part of the return", () => {
    expect(returnQuantityError("", 4)).toBeNull();
    expect(returnQuantityError("   ", 4)).toBeNull();
  });

  it("accepts a whole positive quantity at or below the remaining amount", () => {
    expect(returnQuantityError("1", 4)).toBeNull();
    expect(returnQuantityError("4", 4)).toBeNull();
  });

  it("rejects an over-cap draft with EXCEEDS", () => {
    expect(returnQuantityError("5", 4)).toBe("EXCEEDS");
    expect(returnQuantityError("9", 4)).toBe("EXCEEDS");
  });

  it("rejects zero, negative, fractional, or non-numeric drafts with INVALID", () => {
    expect(returnQuantityError("0", 4)).toBe("INVALID");
    expect(returnQuantityError("-1", 4)).toBe("INVALID");
    expect(returnQuantityError("1.5", 4)).toBe("INVALID");
    expect(returnQuantityError("abc", 4)).toBe("INVALID");
    expect(returnQuantityError("1e1", 4)).toBe("INVALID");
  });
});

describe("remainingReturnableFor (history-aware remaining)", () => {
  it("starts from the sold quantity with no prior returns", () => {
    expect(remainingReturnableFor(saleLine(), [])).toBe(4);
  });

  it("subtracts every already-returned quantity for that exact line", () => {
    expect(remainingReturnableFor(saleLine(), [returnRecord(), returnRecord()])).toBe(2);
  });

  it("floors at zero", () => {
    expect(remainingReturnableFor(saleLine(), [returnRecord(), returnRecord(), returnRecord(), returnRecord()])).toBe(0);
  });
});

describe("ReturnsPanel (new-return form + history)", () => {
  it("renders the empty-history state and disables the line input when nothing is returnable", () => {
    renderPanel(makeInvoice([saleLine({ quantity: 0 })]));
    expect(host.querySelector('[data-testid="returns-empty"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="returns-history"]')).toBeNull();
  });

  it("renders every prior return with its status, refund and a voucher link", async () => {
    returnsData = [returnRecord()];
    renderPanel(makeInvoice([saleLine()]));
    await flushAsync();
    const row = host.querySelector('[data-testid="returns-row"]');
    expect(row?.textContent).toContain("RTN-0001");
    expect(row?.textContent).toContain("900 دج");
    expect(row?.textContent).toContain("قيد المراجعة");
    expect(host.querySelector('[data-testid="return-print-RTN-0001"]')).toBeTruthy();
  });

  it("blocks an over-cap draft client-side and sends nothing", () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "5");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("المتبقي");
    expect(lastCreateInput).toBeNull();
  });

  it("blocks a non-numeric draft and refuses an empty return", () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2x");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("أدخل كمية صحيحة");
    expect(lastCreateInput).toBeNull();

    // a cleared field is not part of the return → the form refuses an all-empty request
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("اختر كمية");
    expect(lastCreateInput).toBeNull();
  });

  it("submits a valid return and announces success in a status role", async () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2");
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-reason"]')!, "الزبون بدل رأيه");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(lastCreateInput).toMatchObject({
      invoiceId: "00000000-0000-4000-8000-0000000000b1",
      lines: [{ invoiceLineId: LINE_ID, quantity: 2 }],
      reason: "الزبون بدل رأيه",
    });
    const done = host.querySelector('[data-testid="returns-done"]');
    expect(done?.getAttribute("role")).toBe("status");
    expect(done?.textContent).toContain("تم تسجيل المرجوع");
  });

  it("shows the server refusal translation when the api rejects a stale cap", async () => {
    renderPanel(makeInvoice([saleLine()]));
    failReturnsCreate = true;
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("الكمية تتجاوز المتبقي القابل للإرجاع");
  });

  it("disables the line input when the whole line is already returned", async () => {
    returnsData = [returnRecord(), returnRecord(), returnRecord(), returnRecord()];
    renderPanel(makeInvoice([saleLine()]));
    await flushAsync();
    expect(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')?.disabled).toBe(true);
  });

  it("shows the return value, the collected-so-far and a soft cash warning when cash exceeds collected", () => {
    // paidAmount 0: the default all-cash settlement for a 3600 return warns
    renderPanel(makeInvoice([saleLine()], 0));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "4");
    expect(host.querySelector('[data-testid="returns-value"]')?.textContent).toContain("3600");
    expect(host.querySelector('[data-testid="returns-collected"]')?.textContent).toContain("0");
    expect(host.querySelector('[data-testid="returns-cash-warning"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="returns-cash-warning"]')?.textContent).toContain("القرار لك");
  });

  it("suppresses the warning when the cash portion stays within what was collected", () => {
    renderPanel(makeInvoice([saleLine()], 9_000));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2");
    expect(host.querySelector('[data-testid="returns-cash-warning"]')).toBeNull();
  });

  it("sends the custom cash portion when the owner splits the settlement", async () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "4");
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="returns-settlement"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "CUSTOM");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!, "1200");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(lastCreateInput?.cashPaidOut).toBe(1200);
  });

  it("sends cash 0 for the all-debt preset", async () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2");
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="returns-settlement"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "ALL_DEBT");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(lastCreateInput?.cashPaidOut).toBe(0);
  });

  it("refuses a custom cash portion above the return value", () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "4");
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="returns-settlement"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "CUSTOM");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!, "4000");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("أدخل مبلغاً نقدياً");
    expect(lastCreateInput).toBeNull();
  });

  it("warns when an all-debt split swings into cash beyond what was collected", () => {
    // remaining 300 < value 500 → the debt cap forces 200 into cash, which the
    // api will actually settle; the warning must track THAT cash, not the
    // requested 0
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 100, 400));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="returns-settlement"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "ALL_DEBT");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("200");
    expect(host.querySelector('[data-testid="returns-cash-warning"]')).toBeTruthy();
  });
});