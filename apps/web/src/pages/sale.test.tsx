import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/** Invoice subset the mocked invoicesCreate resolves with (see InvoiceDetail). */
interface InvoiceResponse {
  invoiceNumber: string;
  remainingAmount: number;
  counterpartyName: string | null;
}

/** Fixture knobs the render tests drive without a network seam. */
interface CapturedInvoiceInput {
  kind?: string;
  counterpartyName?: string;
  initialPaid?: number;
  lines?: Array<{ itemId: string; quantity: number }>;
}

/** Subset of the tanstack mutation options the page passes through. */
interface ItemMutationOptions {
  onSuccess?: (item: { id: string; name: string; sellingPrice: number }) => void;
  onError?: (error: { message?: string }) => void;
}
interface InvoiceMutationOptions {
  onSuccess?: (invoice: InvoiceResponse) => void;
  onError?: (error: { message?: string }) => void;
}

let scanPrice = 1000;
let lastInvoiceInput: CapturedInvoiceInput | null = null;
let resolveInvoice: ((value: InvoiceResponse) => void) | null = null;

// The page pulls its data/mutations through orpc.*; mock the rpc module so the
// pure helpers and the rendered commit states are driven by fixtures.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({ queryKey: ["categories"], queryFn: async () => ({ items: [] }) }),
    },
    // ItemPickerDialog evaluates this useQuery even while closed (before its
    // `if (!open) return null` guard), so the stub must exist on mount.
    catalogSearch: {
      queryOptions: ({ input, enabled }: { input?: unknown; enabled?: boolean } = {}) => ({
        queryKey: ["catalogSearch", input],
        queryFn: async () => ({ matches: [], exact: null }),
        enabled,
      }),
    },
    itemsCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => {
          throw new Error("itemsCreate unused in this test");
        },
        ...opts,
      }),
    },
    itemsCreateWithStock: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => {
          throw new Error("itemsCreateWithStock unused in this test");
        },
        ...opts,
      }),
    },
    // The commit is settled manually by the test so it can observe the pending
    // label and pick the invoice the server "returns".
    invoicesCreate: {
      mutationOptions: (opts?: InvoiceMutationOptions) => ({
        mutationFn: (input: CapturedInvoiceInput) => {
          lastInvoiceInput = input;
          return new Promise<InvoiceResponse>((resolve) => {
            resolveInvoice = resolve;
          });
        },
        ...opts,
      }),
    },
    itemsList: { queryKey: () => ["items"] },
    itemsLowStock: { queryKey: () => ["itemsLowStock"] },
  },
  rpcClient: {
    catalogSearch: async ({ query }: { query: string }) => ({
      exact: { item: { id: `item-${query}`, name: `منتج ${query}`, sellingPrice: scanPrice } },
    }),
  },
}));

const { SalePage, overrideInputInvalid, parseQuantityDraft, quantityDraftInvalid, saleDebt } = await import("./sale");

describe("cart quantity draft (cleared state + deterministic parse)", () => {
  it("parses a cleared or whitespace draft to 0 (invalid, never stuck)", () => {
    expect(parseQuantityDraft("")).toBe(0);
    expect(parseQuantityDraft("   ")).toBe(0);
    expect(quantityDraftInvalid("")).toBe(true);
  });

  it("parses positive integers and rejects zero, negatives, fractions, and garbage", () => {
    expect(parseQuantityDraft("1")).toBe(1);
    expect(parseQuantityDraft("12")).toBe(12);
    expect(parseQuantityDraft(" 7 ")).toBe(7);
    expect(parseQuantityDraft("0")).toBe(0);
    expect(parseQuantityDraft("-3")).toBe(0);
    expect(parseQuantityDraft("2.5")).toBe(0);
    expect(parseQuantityDraft("abc")).toBe(0);
    expect(parseQuantityDraft("12x")).toBe(0);
    expect(quantityDraftInvalid("0")).toBe(true);
    expect(quantityDraftInvalid("2.5")).toBe(true);
  });

  it("accepts a whole multi-digit value and trims surrounding spaces", () => {
    expect(quantityDraftInvalid("42")).toBe(false);
    expect(parseQuantityDraft("0042")).toBe(42);
  });

  it("rejects drafts above the RPC quantity cap instead of surfacing a server error", () => {
    expect(parseQuantityDraft("9999999999")).toBe(0);
    expect(parseQuantityDraft("1000001")).toBe(0);
    expect(parseQuantityDraft("1000000")).toBe(1_000_000);
    expect(quantityDraftInvalid("9999999999")).toBe(true);
  });

  it("is deterministic and pins each input's exact resolution (no self-equality)", () => {
    const cases: Array<[string, number]> = [
      ["", 0],
      ["0", 0],
      ["1", 1],
      ["999", 999],
      ["-1", 0],
      ["1e3", 0],
      ["1.5", 0],
      ["٥", 0],
      ["1_000", 0],
      ["1000000", 1_000_000],
      ["1000001", 0],
    ];
    for (const [input, expected] of cases) {
      expect(parseQuantityDraft(input)).toBe(expected);
    }
  });
});
describe("overrideInputInvalid (sale line price override)", () => {
  it("accepts lines without a chosen override type", () => {
    expect(overrideInputInvalid({ overrideType: "", overrideValue: "" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "", overrideValue: "900" })).toBe(false);
  });

  it("rejects an empty override value once a type is chosen (regression: Number('') === 0 would bill the line free)", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "   " })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "" })).toBe(true);
  });

  it("accepts whole nonnegative amount overrides, including an explicit zero", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "900" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "0" })).toBe(false);
  });

  it("rejects fractional, negative, or non-numeric amount overrides", () => {
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "12.5" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "-5" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "AMOUNT", overrideValue: "abc" })).toBe(true);
  });

  it("binds percentage overrides to whole 0-100 values", () => {
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "80" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "0" })).toBe(false);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "101" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "-1" })).toBe(true);
    expect(overrideInputInvalid({ overrideType: "PERCENTAGE", overrideValue: "12.5" })).toBe(true);
  });
});

describe("saleDebt (pre-commit customer debt preview)", () => {
  it("treats an empty or zero paid draft as the whole total becoming debt", () => {
    expect(saleDebt(1000, "")).toEqual({ valid: true, debt: 1000 });
    expect(saleDebt(1000, "0")).toEqual({ valid: true, debt: 1000 });
  });

  it("leaves the remainder as debt after a partial payment", () => {
    expect(saleDebt(1000, "400")).toEqual({ valid: true, debt: 600 });
    expect(saleDebt(750, "250")).toEqual({ valid: true, debt: 500 });
  });

  it("reports no debt only when the draft exactly covers the total", () => {
    expect(saleDebt(1000, "1000")).toEqual({ valid: true, debt: 0 });
    expect(saleDebt(0, "")).toEqual({ valid: true, debt: 0 });
  });

  it("marks an overpayment invalid because invoice creation rejects it (greptile round-2)", () => {
    expect(saleDebt(1000, "1500")).toEqual({ valid: false, debt: 0 });
  });

  it("flags invalid drafts so the preview stays hidden until submit validates them", () => {
    expect(saleDebt(1000, "-5")).toEqual({ valid: false, debt: 0 });
    expect(saleDebt(1000, "12.5")).toEqual({ valid: false, debt: 0 });
    expect(saleDebt(1000, "abc")).toEqual({ valid: false, debt: 0 });
  });
});

// --- rendered SalePage states ----------------------------------------------

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement; queryClient: QueryClient }> = [];

beforeEach(() => {
  scanPrice = 1000;
  lastInvoiceInput = null;
  resolveInvoice = null;
});

afterEach(async () => {
  const entries = mounted;
  mounted = [];
  for (const entry of entries) {
    await act(async () => entry.root.unmount());
    entry.queryClient.clear();
    entry.host.remove();
  }
  document.body.innerHTML = "";
});

async function mountSale(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SalePage />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host, queryClient });
  return host;
}

/** Drive the barcode path: focus is non-editable, so burst timing is irrelevant. */
async function scan(code: string): Promise<void> {
  await act(async () => {
    for (const character of code) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInput(host: HTMLElement, testId: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing input ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function saveButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="sale-save"]');
  if (button === null) throw new Error("missing sale-save button");
  return button;
}

describe("SalePage commit states (greptile round-2)", () => {
  it("words a pending remainder as unattributed until a customer is named", async () => {
    const host = await mountSale();
    await scan("111");

    let notice = host.querySelector('[data-testid="sale-debt-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("غير منسوب");
    expect(notice?.textContent).not.toContain("للزبون");
    expect(notice?.textContent).toContain("1000");
    expect(notice?.textContent).toContain("تقديري");

    await act(async () => setInput(host, "sale-customer", "أمين"));
    notice = host.querySelector('[data-testid="sale-debt-notice"]');
    expect(notice?.textContent).toContain("سيُنشأ دين");
    expect(notice?.textContent).toContain("للزبون");
    expect(notice?.textContent).not.toContain("غير منسوب");
    expect(notice?.textContent).toContain("تقديري");
  });

  it("shows the saving label while pending, then the server remaining (not cart math) as the debt", async () => {
    const host = await mountSale();
    await scan("222");
    await act(async () => {
      setInput(host, "sale-customer", "أمين");
      setInput(host, "sale-paid", "400"); // cart math would report 600
    });

    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const pending = host.querySelector<HTMLButtonElement>('[data-testid="sale-save"]');
    expect(pending?.textContent).toBe("جارٍ الحفظ…");
    expect(pending?.disabled).toBe(true);
    expect(lastInvoiceInput).toEqual({
      kind: "SALE",
      counterpartyName: "أمين",
      initialPaid: 400,
      lines: [{ itemId: "item-222", quantity: 1 }],
    });

    expect(resolveInvoice).not.toBeNull();
    await act(async () => {
      resolveInvoice?.({ invoiceNumber: "INV-77", remainingAmount: 650, counterpartyName: "أمين" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const savedDebt = host.querySelector('[data-testid="sale-saved-debt"]');
    expect(savedDebt).not.toBeNull();
    expect(savedDebt?.textContent).toContain("650");
    expect(savedDebt?.textContent).not.toContain("600");
    expect(savedDebt?.textContent).toContain("للزبون");
    expect(savedDebt?.textContent).not.toContain("تقديري");
  });

  it("surfaces an unattributed remainder in the confirmation when the sale has no customer", async () => {
    const host = await mountSale();
    await scan("333");

    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      resolveInvoice?.({ invoiceNumber: "INV-88", remainingAmount: 1000, counterpartyName: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const savedDebt = host.querySelector('[data-testid="sale-saved-debt"]');
    expect(savedDebt).not.toBeNull();
    expect(savedDebt?.textContent).toContain("غير منسوب");
    expect(savedDebt?.textContent).not.toContain("للزبون");
    expect(savedDebt?.textContent).toContain("1000");
  });

  it("freezes the pre-save notice to the submitted values while the commit is pending", async () => {
    const host = await mountSale();
    await scan("444");
    await act(async () => {
      setInput(host, "sale-customer", "أمين");
      setInput(host, "sale-paid", "400"); // partial -> notice estimates 600
    });
    expect(host.querySelector('[data-testid="sale-debt-notice"]')?.textContent).toContain("600");

    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The request is in flight; editing the live field to the full amount must
    // not hide the debt the invoice still records.
    await act(async () => {
      setInput(host, "sale-paid", "1000");
    });
    const notice = host.querySelector('[data-testid="sale-debt-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("600");
    expect(notice?.textContent).not.toContain("1000");
  });
});
