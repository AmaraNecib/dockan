import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // initializes i18next (ar) for useTranslation; also resolves option labels

import type { InvoiceDetail, ReturnDetail } from "@dokan/contracts";

import { routerMock } from "../tests/router-mock";

/** returnsList payload the panel should serve, or an error flag / payload for create */
let returnsData: ReturnDetail[] = [];
let failReturnsCreate = false;
/** what the mocked returnsCreate resolves with; a test can override it */
let createdReturn: ReturnDetail | null = null;
let lastCreateInput: { invoiceId: string; lines: Array<{ invoiceLineId: string; quantity: number }>; reason?: string; cashPaidOut?: number } | null = null;

// The page module imports the router Link at module scope; use the shared stub
// so the panel is testable without a network or a router mount.
mock.module("@tanstack/react-router", routerMock);

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
    returnsPendingCount: {
      queryKey: () => ["returnsPendingCount"],
    },
    returnsCreate: {
      mutationOptions: (options?: { onSuccess?: (record: ReturnDetail) => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsCreate"],
        ...options,
        mutationFn: async (input: { invoiceId: string; lines: Array<{ invoiceLineId: string; quantity: number }>; reason?: string }) => {
          lastCreateInput = input;
          if (failReturnsCreate) throw new Error("RETURN_EXCEEDS_RETURNABLE");
          return createdReturn ?? returnRecord();
        },
      }),
    },
  },
  rpcClient: {},
}));

const { returnQuantityError, remainingReturnableFor, ReturnsPanel } = await import("./invoice");

const LINE_ID = "00000000-0000-4000-8000-0000000000c1";
const ITEM_ID = "00000000-0000-4000-8000-0000000000c2";

function makeInvoice(lines: InvoiceDetail["lines"] = [], paidAmount = 900, totalAmount = 900, returnCreditAmount = 0): InvoiceDetail {
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
    remainingAmount: Math.max(0, totalAmount - paidAmount - returnCreditAmount),
    returnCreditAmount,
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
    debtApplied: 0,
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
  createdReturn = null;
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

/** act-wrapped polling so floating-ui positioning and Base UI store updates settle. */
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition not met within timeout");
}

/** Opens the settlement Select and commits the option whose label matches `label`. */
async function pickSettlement(label: string) {
  const trigger = host.querySelector<HTMLElement>('[data-testid="returns-settlement"]')!;
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const optionText = (element: HTMLElement) => (element.textContent ?? "").trim();
  await waitFor(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).some((element) => optionText(element) === label),
  );
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => optionText(element) === label)!;
  act(() => {
    // Base UI items arm mouse selection on pointerdown, then commit on click.
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
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

  it("flags a pending return and separates it from the reviewed ones (issue #118)", async () => {
    returnsData = [
      returnRecord({ id: "00000000-0000-4000-8000-0000000000d3", returnNumber: "RTN-0002", status: "ACCEPTED" }),
      returnRecord(),
    ];
    renderPanel(makeInvoice([saleLine()]));
    await flushAsync();
    const notice = host.querySelector('[data-testid="returns-pending-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("1");
    expect(host.querySelector('[data-testid="returns-counts"]')?.textContent).toContain("قيد المراجعة: 1");
    // pending rows render first even when the api ordered the accepted one first
    const rows = Array.from(host.querySelectorAll('[data-testid="returns-row"]'));
    expect(rows[0]?.textContent).toContain("RTN-0001");
    expect(rows[1]?.textContent).toContain("RTN-0002");
  });

  it("shows no pending notice once every return is reviewed", async () => {
    returnsData = [returnRecord({ status: "ACCEPTED" })];
    renderPanel(makeInvoice([saleLine()]));
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-pending-notice"]')).toBeNull();
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
    expect(done?.textContent).toContain("RTN-0001");
    // the detail line renders the «دج» token (never "DA")
    const detail = host.querySelector('[data-testid="returns-done-detail"]');
    expect(detail?.textContent).toContain("900");
    expect(detail?.textContent).toContain("دج");
    expect(detail?.textContent).not.toContain("DA");
    // the card offers the saved return's voucher (id, not number) and the
    // invoice, and replaces the form until the owner asks for another return
    expect(host.querySelector('[data-testid="returns-form"]')).toBeNull();
    const voucher = host.querySelector<HTMLAnchorElement>('[data-testid="returns-open-voucher"]');
    expect(voucher?.getAttribute("href")).toContain("/invoices/$invoiceId/returns/$returnId/print");
    expect(voucher?.getAttribute("href")).toContain("returnId=00000000-0000-4000-8000-0000000000d1");
    expect(host.querySelector('[data-testid="returns-open-invoice"]')?.getAttribute("href")).toContain("invoiceId=00000000-0000-4000-8000-0000000000b1");

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="returns-new"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="returns-form"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="returns-done"]')).toBeNull();
  });

  it("renders the debt portion of an all-debt return in the completion detail (issue #159)", async () => {
    createdReturn = returnRecord({ cashPaidOut: 0, debtOffset: 900, debtApplied: 0 });
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    const detail = host.querySelector('[data-testid="returns-done-detail"]');
    expect(detail?.textContent).toContain("خُصم من الدَّين");
    expect(detail?.textContent).toContain("900");
  });

  it("keeps the return fields visible in both themes (issue #160)", async () => {
    renderPanel(makeInvoice([saleLine()]));
    const reason = host.querySelector<HTMLInputElement>('[data-testid="returns-reason"]')!;
    expect(reason.className).toContain("border-input");
    expect(reason.className).toContain("bg-background");
    expect(reason.className).toContain("focus-visible:ring-ring/40");
    expect(reason.className).toContain("dark:bg-input/30");
    // the quantity and custom-cash fields keep the token edge/focus ring too
    const quantity = host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!;
    expect(quantity.className).toContain("border-input");
    expect(quantity.className).toContain("focus-visible:ring-ring/40");
    await pickSettlement("تقسيم مخصص");
    const cash = host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!;
    expect(cash.className).toContain("border-input");
    expect(cash.className).toContain("focus-visible:ring-ring/40");
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
    expect(host.querySelector('[data-testid="returns-value"]')?.textContent).toBe("3600 دج");
    expect(host.querySelector('[data-testid="returns-collected"]')?.textContent).toBe("0 دج");
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
    await pickSettlement(i18n.t("returnsSplitCustom"));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!, "1200");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(lastCreateInput?.cashPaidOut).toBe(1200);
  });

  it("sends cash 0 for the all-debt preset", async () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    await flushAsync();
    expect(lastCreateInput?.cashPaidOut).toBe(0);
  });

  it("refuses a custom cash portion above the return value", async () => {
    renderPanel(makeInvoice([saleLine()]));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "4");
    await pickSettlement(i18n.t("returnsSplitCustom"));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!, "4000");
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="returns-form"]')!);
    expect(host.querySelector('[data-testid="returns-error"]')?.textContent).toContain("أدخل مبلغاً نقدياً");
    expect(lastCreateInput).toBeNull();
  });

  it("warns when an all-debt split swings into cash beyond what was collected", async () => {
    // remaining 300 < value 500 → the debt cap forces 200 into cash, which the
    // api will actually settle; the warning must track THAT cash, not the
    // requested 0
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 100, 400));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("200");
    expect(host.querySelector('[data-testid="returns-cash-warning"]')).toBeTruthy();
  });

  it("notes that the debt portion applies only on acceptance (#68)", async () => {
    // invoice total 400, paid 100 → remaining 300; an ALL_DEBT split on the
    // 500 line projects a 300 debt portion — the panel must tell the counter
    // owner the invoice keeps its debt until the return is accepted
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 100, 400));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    const note = host.querySelector('[data-testid="returns-debt-note"]');
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain("عند قبول المرجوع");
    expect(note?.textContent).toContain("تبقى مدينة");
  });

  it("hides the acceptance note when the settlement carries no debt portion (#68)", () => {
    // the default all-cash settlement on a fully unpaid invoice has no debt
    renderPanel(makeInvoice([saleLine()], 0));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    expect(host.querySelector('[data-testid="returns-debt-note"]')).toBeNull();
  });

  it("shows the invoice's remaining debt, not only what was collected", () => {
    // total 900, paid 600 → remaining 300. Showing only المحصل (600) reads as
    // "room to offset" and is exactly what made a capped split look like a bug:
    // the counter owner needs the 300 that actually bounds the debt portion
    renderPanel(makeInvoice([saleLine({ netTotal: 900, quantity: 3, total: 900 })], 600));
    expect(host.querySelector('[data-testid="returns-remaining-debt"]')?.textContent).toBe("300 دج");
    expect(host.querySelector('[data-testid="returns-collected"]')?.textContent).toBe("600 دج");
  });

  it("names the cash forced by the debt cap instead of letting it appear silently", async () => {
    // invoice total 400, paid 100 → remaining 300. Returning a 500 line with
    // "all debt" asked for: only 300 fits the debt, so 200 MUST be handed back
    // as cash — the panel has to say so, not merely render a different number
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 100, 400));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toBe("300 دج");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toBe("200 دج");
    const note = host.querySelector('[data-testid="returns-debt-cap-note"]');
    expect(note).toBeTruthy();
    // pins WHICH figure is which — a swapped i18n interpolation still contains
    // both numbers, so assert their order (remaining first, then the cash)
    expect((note?.textContent ?? "").match(/\d+/g)).toEqual(["300", "200"]);
  });

  it("shows no cap note when the debt absorbs the whole offset", async () => {
    // total 900, paid 0 → remaining 900 swallows the whole 500 return
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 0, 900));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toBe("500 دج");
    expect(host.querySelector('[data-testid="returns-debt-cap-note"]')).toBeNull();
  });

  it("renders a zero debt offset, all cash, when nothing is owed", async () => {
    // remaining 0: the return cannot touch the debt at all, so the whole value
    // is cash — and the note must still read sensibly with remaining 0
    renderPanel(makeInvoice([saleLine({ netTotal: 900, quantity: 3, total: 900 })], 900, 900));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toBe("0 دج");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toBe("300 دج");
    expect((host.querySelector('[data-testid="returns-debt-cap-note"]')?.textContent ?? "").match(/\d+/g)).toEqual(["0", "300"]);
  });

  it("treats a return worth exactly the debt as not capped", async () => {
    // remaining 500, return 500: equality is the only case separating the cap's
    // `>` from a `>=` regression, and no other test sits on it
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 0, 500));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitAllDebt"));
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toBe("500 دج");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toBe("0 دج");
    expect(host.querySelector('[data-testid="returns-debt-cap-note"]')).toBeNull();
  });

  it("renders the custom split the owner typed", async () => {
    // value 500, remaining 900, cash 200 → the other 300 goes to the debt
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 0, 900));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitCustom"));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!, "200");
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toBe("300 دج");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toBe("200 دج");
    expect(host.querySelector('[data-testid="returns-debt-cap-note"]')).toBeNull();
  });

  it("shows the forced-cash floor as the custom cash placeholder", async () => {
    // value 500 with only 300 of debt → anything under 200 must become cash,
    // so the example range in the field starts there
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 200, 500));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitCustom"));
    expect(host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')?.getAttribute("placeholder")).toBe("200 – 500");
  });

  it("hides the split instead of rendering NaN or a negative for a bad cash draft", async () => {
    // only submit is blocked by customCashError, so the projection must refuse
    // to draw a figure the api would never accept
    renderPanel(makeInvoice([saleLine({ netTotal: 500, quantity: 1, total: 500 })], 0, 900));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await pickSettlement(i18n.t("returnsSplitCustom"));
    const cash = host.querySelector<HTMLInputElement>('[data-testid="returns-cash"]')!;
    typeInto(cash, "abc");
    expect(host.querySelector('[data-testid="returns-debt-offset"]')).toBeNull();
    expect(host.querySelector('[data-testid="returns-cash-now"]')).toBeNull();
    typeInto(cash, "-5");
    expect(host.querySelector('[data-testid="returns-debt-offset"]')).toBeNull();
    expect(host.querySelector('[data-testid="returns-cash-now"]')).toBeNull();
    expect(host.querySelector('[data-testid="returns-debt-cap-note"]')).toBeNull();
  });

  it("prices the completing return at the exact remainder, not qty × unit price", async () => {
    // net 101 over 3 units: an earlier return of 1 unit already refunded 34, so
    // bringing back the last 2 must preview 67 (101 − 34), never 2 × 34 = 68.
    // The api's sequence-aware computeReturnRefund is now the ONE implementation
    // both sides call, so the figure promised is the figure persisted.
    returnsData = [
      returnRecord({
        status: "ACCEPTED",
        lines: [{ ...returnRecord().lines[0]!, quantity: 1, refundUnitPrice: 34, refundAmount: 34 }],
      }),
    ];
    renderPanel(makeInvoice([saleLine({ netTotal: 101, quantity: 3, total: 101 })], 0));
    await flushAsync();
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "2");
    expect(host.querySelector('[data-testid="returns-value"]')?.textContent).toBe("67 دج");
  });

  it("labels the quantity field so what to type is unmistakable", () => {
    renderPanel(makeInvoice([saleLine()], 900));
    const input = host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!;
    expect(input.getAttribute("aria-label")).toContain(i18n.t("returnQuantity"));
    expect(input.getAttribute("aria-label")).toContain("بطارية");
    expect(host.textContent).toContain(i18n.t("returnQuantity"));
    expect(host.textContent).toContain(i18n.t("returnsUnitPiece"));
  });

  it("says a line has nothing left to return rather than showing a dead field", async () => {
    // this line sold a single unit and the fixture return already took it
    returnsData = [returnRecord()];
    renderPanel(makeInvoice([saleLine({ quantity: 1, netTotal: 900, total: 900 })], 900));
    await flushAsync();
    expect(host.textContent).toContain(i18n.t("returnsNothingLeft"));
    expect(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')?.disabled).toBe(true);
  });
});
