import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { InvoiceDetail } from "@dokan/contracts";

/** which procedure the mocked seam should fail on, or null for success */
let failInvoicesPay = false;
/** last mutation input, for asserting what the panel actually sends */
let lastPayInput: { invoiceId: string; amount: number; method: string; note?: string } | null = null;

// The page module imports the rpc client at module scope; stub the whole
// seam so the panel is testable without a network. The mock mirrors the real
// util surface (queryOptions AND queryKey AND mutationOptions) so a future
// render path can never hit a missing key at runtime.
mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesGet: {
      queryOptions: () => ({ queryKey: ["invoicesGet"], queryFn: async () => undefined }),
      queryKey: ({ input }: { input: { id: string } }) => ["invoicesGet", input],
    },
    invoicesList: { queryKey: () => ["invoicesList"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
    invoicesPay: {
      // merges the caller's { onSuccess, onError } like the real utils do
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["invoicesPay"],
        ...options,
        mutationFn: async (input: { invoiceId: string; amount: number; method: string; note?: string }) => {
          lastPayInput = input;
          if (failInvoicesPay) throw new Error("PAYMENT_EXCEEDS_REMAINING");
          return { ok: true };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { paymentAmountError, PaymentPanel } = await import("./invoice");

function makeInvoice(remaining: number, payments: InvoiceDetail["payments"] = []): InvoiceDetail {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    invoiceNumber: "INV-0001",
    kind: "SALE",
    counterpartyId: null,
    counterpartyName: "زبون",
    invoiceDate: "2026-08-25",
    subtotalAmount: 900,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount: 900,
    paidAmount: 900 - remaining,
    remainingAmount: remaining,
    notes: null,
    createdAt: "2026-08-25T10:00:00",
    updatedAt: "2026-08-25T10:00:00",
    lines: [],
    payments,
  };
}

let roots: Array<{ unmount: () => void }> = [];
let host = document.createElement("div");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  failInvoicesPay = false;
  lastPayInput = null;
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
        <PaymentPanel invoice={invoice} />
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

/** Flushes the mocked mutation's async resolve/reject (promise + scheduler
 * timers) inside act so the success/error UI renders before assertions. */
async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("paymentAmountError (invoice instalment boundary)", () => {
  it("accepts an exact-remaining payment (boundary)", () => {
    expect(paymentAmountError("800", 800)).toBeNull();
    expect(paymentAmountError("1", 1)).toBeNull();
  });

  it("accepts any positive whole instalment below the remaining amount", () => {
    expect(paymentAmountError("300", 800)).toBeNull();
    expect(paymentAmountError("1", 800)).toBeNull();
  });

  it("rejects a +1 DZD overpayment with EXCEEDS", () => {
    expect(paymentAmountError("801", 800)).toBe("EXCEEDS");
    expect(paymentAmountError("900", 800)).toBe("EXCEEDS");
  });

  it("refuses any amount on a fully paid invoice", () => {
    expect(paymentAmountError("1", 0)).toBe("EXCEEDS");
  });

  it("rejects empty, zero, negative, fractional, or non-numeric input with INVALID", () => {
    expect(paymentAmountError("", 800)).toBe("INVALID");
    expect(paymentAmountError("   ", 800)).toBe("INVALID");
    expect(paymentAmountError("0", 800)).toBe("INVALID");
    expect(paymentAmountError("-5", 800)).toBe("INVALID");
    expect(paymentAmountError("12.5", 800)).toBe("INVALID");
    expect(paymentAmountError("abc", 800)).toBe("INVALID");
    expect(paymentAmountError("NaN", 800)).toBe("INVALID");
  });

  it("rejects numeric-string spellings that would silently coerce (1e3, 0x10, 12., padded)", () => {
    expect(paymentAmountError("1e3", 800)).toBe("INVALID");
    expect(paymentAmountError("0x10", 800)).toBe("INVALID");
    expect(paymentAmountError("12.", 800)).toBe("INVALID");
    expect(paymentAmountError(" 12 ", 800)).toBeNull(); // trimmed digits are fine
    expect(paymentAmountError("9007199254740993", 800)).toBe("INVALID"); // > MAX_SAFE_INTEGER
  });
});

describe("PaymentPanel (invoice payment form + history)", () => {
  it("renders the empty-history state when no payments exist", () => {
    renderPanel(makeInvoice(900));
    expect(host.querySelector('[data-testid="pmt-empty"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="pmt-history"]')).toBeNull();
  });

  it("renders every history row in the invoice's order with amount and method", () => {
    renderPanel(
      makeInvoice(400, [
        { id: "p1", invoiceId: "inv", amount: 300, method: "CASH", note: "أول دفعة", paidAt: "2026-08-25T10:01:00", createdAt: "2026-08-25T10:01:00" },
        { id: "p2", invoiceId: "inv", amount: 200, method: "BANK", note: null, paidAt: "2026-08-25T10:01:00", createdAt: "2026-08-25T10:01:00" },
      ]),
    );
    const rows = Array.from(host.querySelectorAll('[data-testid="pmt-row"]'));
    const cells = rows.map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
    expect(cells).toEqual([
      ["2026-08-25T10:01:00", "300 دج", "نقداً", "أول دفعة"],
      ["2026-08-25T10:01:00", "200 دج", "تحويل بنكي", "—"],
    ]);
  });

  it("blocks an overpay client-side with the exact remaining message and sends nothing", () => {
    renderPanel(makeInvoice(600));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="pmt-amount"]')!, "601");
    submitForm(host.querySelector<HTMLFormElement>("form")!);
    expect(host.querySelector('[data-testid="pmt-error"]')?.textContent).toContain("المبلغ يتجاوز المتبقي");
    expect(lastPayInput).toBeNull();
  });

  it("submits a valid instalment and announces success in a status role", async () => {
    renderPanel(makeInvoice(600));
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="pmt-amount"]')!, "600");
    submitForm(host.querySelector<HTMLFormElement>("form")!);
    await flushAsync();
    expect(lastPayInput).toMatchObject({ invoiceId: "00000000-0000-4000-8000-000000000001", amount: 600, method: "CASH" });
    const done = host.querySelector('[data-testid="pmt-done"]');
    expect(done?.getAttribute("role")).toBe("status");
    expect(done?.textContent).toContain("تم تسجيل الدفعة");
  });

  it("shows the server PAYMENT_EXCEEDS_REMAINING translation when a stale remaining is refused", async () => {
    renderPanel(makeInvoice(600));
    failInvoicesPay = true;
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="pmt-amount"]')!, "600");
    submitForm(host.querySelector<HTMLFormElement>("form")!);
    await flushAsync();
    expect(host.querySelector('[data-testid="pmt-error"]')?.textContent).toContain("المبلغ يتجاوز المتبقي من الفاتورة");
  });

  it("locks the form with the paid-off message when remaining is zero", () => {
    renderPanel(makeInvoice(0));
    expect(host.querySelector('[data-testid="pmt-unavailable"]')?.textContent).toContain("مسدّدة بالكامل");
    expect(host.querySelector('[data-testid="pmt-submit"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="pmt-amount"]')?.disabled).toBe(true);
  });
});
