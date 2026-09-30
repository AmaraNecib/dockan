import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SaleDraftProvider } from "@/components/app/sale-draft";

import { activateOption, chooseOption, findOption, openSelect } from "../tests/select-driver";

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
let scanFails = false;
let lastInvoiceInput: CapturedInvoiceInput | null = null;
let resolveInvoice: ((value: InvoiceResponse) => void) | null = null;
let resolveItemCreate: ((item: { id: string; name: string; sellingPrice: number }) => void) | null = null;
/** holds the category list open so the quick-add can open before it arrives */
let categoriesGate: Promise<void> | null = null;
let releaseCategoriesGate: (() => void) | null = null;

// The page pulls its data/mutations through orpc.*; mock the rpc module so the
// pure helpers and the rendered commit states are driven by fixtures.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({
        queryKey: ["categories"],
        queryFn: async () => {
          if (categoriesGate !== null) await categoriesGate;
          return { items: [{ id: "cat-1", name: "تصنيف" }] };
        },
      }),
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
        mutationFn: () =>
          new Promise<{ id: string; name: string; sellingPrice: number }>((resolve) => {
            resolveItemCreate = resolve;
          }),
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
    catalogSearch: async ({ query }: { query: string }) => {
      if (scanFails) throw new Error("UNEXPECTED");
      return { exact: { item: { id: `item-${query}`, name: `منتج ${query}`, sellingPrice: scanPrice } } };
    },
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
  scanFails = false;
  lastInvoiceInput = null;
  resolveInvoice = null;
  resolveItemCreate = null;
  categoriesGate = null;
  releaseCategoriesGate = null;
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
        {/* SalePage publishes its draft and pending flags through this provider,
            which the shell mounts above it; the harness must supply it too */}
        <SaleDraftProvider>
          <SalePage />
        </SaleDraftProvider>
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

function setElementValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setInput(host: HTMLElement, testId: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing input ${testId}`);
  setElementValue(input, value);
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

  it("makes the sale non-editable while the commit is in flight", async () => {
    const host = await mountSale();
    await scan("555");
    // give the line an override so the override-value input renders too
    const overrideType = host.querySelector<HTMLButtonElement>('button[aria-label$="نوع تعديل السعر"]');
    if (overrideType === null) throw new Error("missing override type select");
    await chooseOption(overrideType, "مبلغ");
    await act(async () => {
      const overrideValue = host.querySelector<HTMLInputElement>('input[aria-label$="قيمة تعديل السعر"]');
      if (overrideValue === null) throw new Error("missing override value input");
      setElementValue(overrideValue, "900");
      setInput(host, "sale-customer", "أمين");
      setInput(host, "sale-paid", "400");
    });

    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const disabled = (selector: string): boolean =>
      host.querySelector<HTMLInputElement | HTMLButtonElement>(selector)?.disabled ?? false;
    expect(disabled('[data-testid="sale-customer"]')).toBe(true);
    expect(disabled('[data-testid="sale-paid"]')).toBe(true);
    expect(disabled('[data-testid="sale-open-picker"]')).toBe(true);
    expect(disabled('[data-testid="sale-quick-add"]')).toBe(true);
    expect(disabled('[data-testid="sale-quick-stock-add"]')).toBe(true);
    expect(disabled('[data-testid="sale-discount-type"]')).toBe(true);
    expect(disabled('[data-testid="sale-discount-value"]')).toBe(true);
    expect(disabled('input[aria-label$="الكمية"]')).toBe(true);
    expect(disabled('button[aria-label$="نوع تعديل السعر"]')).toBe(true);
    expect(disabled('input[aria-label$="قيمة تعديل السعر"]')).toBe(true);
    expect(disabled('button[aria-label^="حذف"]')).toBe(true);

    // the frozen notice still reflects the submitted sale (900 total - 400 paid)
    const notice = host.querySelector('[data-testid="sale-debt-notice"]');
    expect(notice?.textContent).toContain("500");
    expect(notice?.textContent).toContain("للزبون");
  });

  it("disables the sale Save while a quick-add is outstanding", async () => {
    const host = await mountSale();
    await scan("222");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => setInput(host, "sale-quick-name", "منتج سريع"));
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="sale-quick-form"]')?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveItemCreate).not.toBeNull();
    expect(saveButton(host).disabled).toBe(true);
  });

  it("does not add a late quick-add line to a sale already being committed", async () => {
    const host = await mountSale();
    await scan("111"); // one line in the cart

    // open + fill the quick-add form but leave it unsubmitted
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => setInput(host, "sale-quick-name", "منتج سريع"));

    // commit the sale; the quick form stays open while the request is in flight
    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // submit the quick form and let its creation settle AFTER the sale started
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="sale-quick-form"]')?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveItemCreate).not.toBeNull();
    await act(async () => {
      resolveItemCreate?.({ id: "item-quick", name: "منتج سريع", sellingPrice: 700 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // the late line was never appended, and the invoice took only the original line
    expect(host.querySelectorAll("tbody tr").length).toBe(1);
    expect(host.querySelector("tbody tr td")?.textContent).toBe("منتج 111");
    expect(lastInvoiceInput?.lines).toEqual([{ itemId: "item-111", quantity: 1 }]);
  });
});

describe("SalePage learnability (issue #94)", () => {
  it("teaches the first step on an empty invoice and hides checkout-only controls", async () => {
    const host = await mountSale();

    const empty = host.querySelector('[data-testid="sale-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("أضف أول منتج إلى الفاتورة");
    expect(empty?.textContent).toContain("امسح باركود المنتج أو اختره من القائمة");

    // checkout-only controls cannot occupy an empty invoice
    expect(host.querySelector('[data-testid="sale-checkout-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-discount-type"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-discount-value"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-save"]')).toBeNull();

    // both create paths stay reachable (E2E testids), demoted but present
    expect(host.querySelector('[data-testid="sale-quick-add"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sale-quick-stock-add"]')).not.toBeNull();
  });

  it("opens the catalog picker from the empty state's pressable action", async () => {
    const host = await mountSale();
    const pickerAction = host.querySelector<HTMLButtonElement>('[data-testid="sale-empty"] [data-testid="sale-open-picker"]');
    expect(pickerAction).not.toBeNull();

    await act(async () => {
      pickerAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="picker-dialog"]')).not.toBeNull();
  });

  it("reveals the discount controls and checkout bar only once a line exists", async () => {
    const host = await mountSale();
    await scan("777");

    expect(host.querySelector('[data-testid="sale-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-checkout-bar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sale-discount-type"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sale-discount-value"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sale-save"]')).not.toBeNull();

    // exactly one picker action is on screen at any time
    expect(host.querySelectorAll('[data-testid="sale-open-picker"]').length).toBe(1);
  });

  it("surfaces a submit error inside the checkout bar once a line exists", async () => {
    const host = await mountSale();
    await scan("888");
    await act(async () => setInput(host, "sale-paid", "-5"));
    await act(async () => {
      saveButton(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const bar = host.querySelector('[data-testid="sale-checkout-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[data-testid="sale-error"]')).not.toBeNull();
    expect(bar?.textContent).toContain("أدخل مبلغاً صحيحاً غير سالب");
  });

  it("shows a scan error on an empty invoice where the empty state is", async () => {
    const host = await mountSale();
    scanFails = true;
    await scan("000");

    const error = host.querySelector('[data-testid="sale-error"]');
    expect(error).not.toBeNull();
    expect(error?.getAttribute("role")).toBe("alert");
    // no checkout bar yet, so the error must live with the empty state
    expect(host.querySelector('[data-testid="sale-checkout-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-empty"]')).not.toBeNull();
  });

  it("clears the discount with the last line and reopens the teaching empty state", async () => {
    const host = await mountSale();
    await scan("999");

    const discountType = host.querySelector<HTMLButtonElement>('[data-testid="sale-discount-type"]');
    if (discountType === null) throw new Error("missing discount type");
    await chooseOption(discountType, "نسبة مئوية");
    await act(async () => setInput(host, "sale-discount-value", "10"));

    const remove = host.querySelector<HTMLButtonElement>('button[aria-label^="حذف"]');
    if (remove === null) throw new Error("missing remove button");
    // the row control is an icon with a real accessible name
    expect(remove.getAttribute("aria-label")).toBe("حذف منتج 999");
    await act(async () => {
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="sale-checkout-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="sale-empty"]')).not.toBeNull();

    // a fresh line starts with no stale discount
    await scan("998");
    expect(host.querySelector<HTMLInputElement>('[name="discountType"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('[data-testid="sale-discount-value"]')?.value).toBe("");
  });

  it("opens the themed discount select, selects a value, and closes", async () => {
    const host = await mountSale();
    await scan("606");

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="sale-discount-type"]');
    if (trigger === null) throw new Error("missing discount select");
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await openSelect(trigger);
    const option = await findOption("نسبة مئوية");
    expect(option).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await activateOption(option!);
    // popup closes and the trigger shows the chosen label
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("نسبة مئوية");
    // the selection propagates to the form value
    expect(host.querySelector<HTMLInputElement>('[name="discountType"]')?.value).toBe("PERCENTAGE");
  });

  it("opens the themed quick-add category select, selects, and closes", async () => {
    const host = await mountSale();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-category"]');
    if (trigger === null) throw new Error("missing quick category select");

    await openSelect(trigger);
    const option = await findOption("تصنيف");
    expect(option).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await activateOption(option!);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // the category id reaches the form value
    expect(host.querySelector<HTMLInputElement>('[name="quickCategory"]')?.value).toBe("cat-1");
  });

  it("shows the category the quick-add will actually save into", async () => {
    // the form can open before the category list arrives; the trigger and the
    // value submit uses must agree on which category is the target
    categoriesGate = new Promise<void>((resolve) => {
      releaseCategoriesGate = resolve;
    });
    const host = await mountSale();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // the list lands after the form is already open
    await act(async () => {
      releaseCategoriesGate?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="sale-quick-category"]');
    expect(trigger?.textContent).toContain("تصنيف");
    expect(host.querySelector<HTMLInputElement>('[name="quickCategory"]')?.value).toBe("cat-1");
  });

  it("clears an invoice discount back to none through the themed select", async () => {
    const host = await mountSale();
    await scan("707");

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="sale-discount-type"]');
    if (trigger === null) throw new Error("missing discount select");
    await chooseOption(trigger, "نسبة مئوية");
    expect(host.querySelector<HTMLInputElement>('[name="discountType"]')?.value).toBe("PERCENTAGE");

    await act(async () => setInput(host, "sale-discount-value", "10"));
    expect(host.querySelector<HTMLInputElement>('[data-testid="sale-discount-value"]')?.disabled).toBe(false);

    await chooseOption(trigger, "بدون خصم");
    expect(host.querySelector<HTMLInputElement>('[name="discountType"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('[data-testid="sale-discount-value"]')?.disabled).toBe(true);
  });

  it("clears a per-line price override back to the default", async () => {
    const host = await mountSale();
    await scan("717");

    const overrideType = host.querySelector<HTMLButtonElement>('button[aria-label$="نوع تعديل السعر"]');
    if (overrideType === null) throw new Error("missing override select");
    await chooseOption(overrideType, "مبلغ");
    expect(host.querySelector('input[aria-label$="قيمة تعديل السعر"]')).not.toBeNull();

    await chooseOption(overrideType, "الافتراضي");
    expect(host.querySelector('input[aria-label$="قيمة تعديل السعر"]')).toBeNull();
  });

  it("keeps a typed override value when the same type is re-selected", async () => {
    const host = await mountSale();
    await scan("727");

    const overrideType = host.querySelector<HTMLButtonElement>('button[aria-label$="نوع تعديل السعر"]');
    if (overrideType === null) throw new Error("missing override select");
    await chooseOption(overrideType, "مبلغ");
    const overrideValue = host.querySelector<HTMLInputElement>('input[aria-label$="قيمة تعديل السعر"]');
    if (overrideValue === null) throw new Error("missing override value");
    await act(async () => setElementValue(overrideValue, "900"));

    await chooseOption(overrideType, "مبلغ");
    expect(host.querySelector<HTMLInputElement>('input[aria-label$="قيمة تعديل السعر"]')?.value).toBe("900");
  });
});
