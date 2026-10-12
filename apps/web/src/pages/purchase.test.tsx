import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { chooseOption } from "../tests/select-driver";
import { routerMock } from "../tests/router-mock";

interface ProposalFixture {
  invoiceId: string;
  items: Array<{
    itemId: string;
    itemName: string;
    lineQuantity: number;
    uninvoicedQty: number;
    proposedLinkQty: number;
    remainderQty: number;
  }>;
}

/** subset of the tanstack mutation options the panel passes through */
interface PanelMutationOptions {
  onSuccess?: (result: { linked: number; remainderMoved: number }) => void;
  onError?: (error: { message?: string }) => void;
}

/** PartyPicker create options (issue 120); the picker passes callbacks per call. */
interface PartyCreateMutationOptions {
  onSuccess?: (party: { id: string; name: string; phone: string | null; createdAt: string }) => void;
  onError?: (error: { message?: string }) => void;
}

let fixture: ProposalFixture = { invoiceId: "inv-1", items: [] };
let lastLinkAllocation: { itemId: string; quantity: number } | null = null;
/** the picker's loaded supplier list and the last invoice input (issue 120) */
let supplierFixtures: Array<{ id: string; name: string; phone: string | null; createdAt: string; stats: { invoiceCount: number; totalAmount: number; paidAmount: number; remainingAmount: number } }> = [];
let lastPurchaseInput: { counterpartyId?: string; counterpartyName?: string; initialPaid?: number } | null = null;
/** the invoice shape the completion card reads, so a test can override it */
interface PurchaseInvoiceResult {
  id: string;
  invoiceNumber: string;
  remainingAmount: number;
  counterpartyName: string | null;
}
let purchaseInvoiceResult: PurchaseInvoiceResult = { id: "inv-1", invoiceNumber: "INV-1", remainingAmount: 0, counterpartyName: null };

// The page renders the completion card's router Links; one shared stub keeps
// PurchasePage testable without a router mount.
mock.module("@tanstack/react-router", routerMock);

// The panel resolves proposal + link through orpc.*.queryOptions/mutationOptions;
// mock the rpc module so tests drive fixtures without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({
        queryKey: ["categories"],
        queryFn: async () => ({ items: [{ id: "cat-1", name: "تصنيف" }] }),
      }),
    },
    // the post-save screen renders InvoiceHeader, which reads store identity
    settingsGet: {
      queryOptions: () => ({
        queryKey: ["settings"],
        queryFn: async () => ({ storeName: "متجر الاختبار", storePhone: null, storeAddress: null }),
      }),
    },
    itemsList: { queryKey: () => ["items"] },
    catalogSearch: {
      queryOptions: () => ({
        queryKey: ["catalogSearch"],
        queryFn: async () => ({ matches: [], exact: null }),
        enabled: false,
      }),
    },
    itemsCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: PanelMutationOptions) => ({
        mutationFn: async () => ({ id: "item-1", name: "منتج", costPrice: 100, sellingPrice: 150 }),
        ...opts,
      }),
    },
    invoicesCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: PanelMutationOptions) => ({
        mutationFn: async (input: { counterpartyId?: string; counterpartyName?: string; initialPaid?: number }) => {
          lastPurchaseInput = input;
          return purchaseInvoiceResult;
        },
        ...opts,
      }),
    },
    purchasesProposal: {
      queryOptions: ({ input }: { input: { invoiceId: string } }) => ({
        queryKey: ["purchasesProposal", input],
        queryFn: async (): Promise<ProposalFixture> => fixture,
      }),
      // SAFETY: mirror the real tanstack-query utils signature ({ input })
      queryKey: (args: { input: { invoiceId: string } }) => ["purchasesProposal", args.input],
    },
    purchasesLinkStock: {
      // SAFETY: pass caller options through so onSuccess (cache reset) survives
      mutationOptions: (opts?: PanelMutationOptions) => ({
        mutationFn: async (input: { invoiceId: string; allocations: Array<{ itemId: string; quantity: number }> }) => {
          lastLinkAllocation = input.allocations[0] ?? null;
          // linking consumes the whole pool BEFORE onSuccess runs, exactly
          // like the real seam — later refetches must see the emptied pool
          fixture = {
            invoiceId: fixture.invoiceId,
            items: fixture.items.map((entry) => ({ ...entry, uninvoicedQty: 0, proposedLinkQty: 0 })),
          };
          return { linked: input.allocations[0]?.quantity ?? 0, remainderMoved: 0 };
        },
        ...opts,
      }),
    },
    // PartyPicker (issue 120): mounts its list query and create mutations on
    // the purchase form.
    suppliersList: {
      queryOptions: () => ({ queryKey: ["suppliers"], queryFn: async () => ({ items: supplierFixtures }) }),
      queryKey: () => ["suppliers"],
    },
    customersList: {
      queryOptions: () => ({ queryKey: ["customers"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["customers"],
    },
    suppliersCreate: {
      mutationOptions: (opts?: PartyCreateMutationOptions) => ({ mutationFn: async () => ({ id: "s-1", name: "مورد", phone: null, createdAt: "" }), ...opts }),
    },
    customersCreate: {
      mutationOptions: (opts?: PartyCreateMutationOptions) => ({ mutationFn: async () => ({ id: "c-1", name: "زبون", phone: null, createdAt: "" }), ...opts }),
    },
  },
  rpcClient: {},
}));

const { LinkProposalPanel, PurchasePage } = await import("./purchase");

const row = (over: Partial<ProposalFixture["items"][number]> = {}): ProposalFixture["items"][number] => ({
  itemId: "item-1",
  itemName: "بطارية",
  lineQuantity: 5,
  uninvoicedQty: 3,
  proposedLinkQty: 3,
  remainderQty: 2,
  ...over,
});

/** mounts the panel and returns a snapshot-driven interaction helper */
async function mountPanel(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LinkProposalPanel invoiceId="inv-1" />
      </QueryClientProvider>,
    );
  });
  return {
    text: () => container.textContent ?? "",
    button: () => container.querySelector<HTMLButtonElement>("button"),
    emptyState: () => container.textContent?.includes("لا يوجد مخزون سابق غير مُفوتر") ?? false,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    waitFor: async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (check()) return true;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      return false;
    },
  };
}

describe("LinkProposalPanel cache reset after linking (greptile round-2)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
  });

  it("refetches the proposal after a successful link so the button cannot double-submit", async () => {
    // fresh pool: one item with 3 linkable units
    fixture = { invoiceId: "inv-1", items: [row()] };

    const ui = await mountPanel(queryClient);
    const appeared = await ui.waitFor(() => ui.button() !== null);
    expect(appeared).toBe(true);
    expect(ui.text()).toContain("3");

    // one click links everything the proposal offered
    await act(async () => {
      ui.button()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await ui.waitFor(() => (lastLinkAllocation ?? null) !== null);
    expect(lastLinkAllocation).toEqual({ itemId: "item-1", quantity: 3 });

    // onSuccess invalidated the proposal query → refetch sees an empty pool
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // stale button + old quantities must be gone; second submit impossible
    expect(ui.emptyState()).toBe(true);
    expect(ui.button()).toBeNull();

    await ui.unmount();
  });

  it("keeps the result message visible while the rows refresh", async () => {
    fixture = { invoiceId: "inv-1", items: [row()] };
    const ui = await mountPanel(queryClient);
    await ui.waitFor(() => ui.button() !== null);

    await act(async () => {
      ui.button()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const linkedShown = await ui.waitFor(() => ui.text().includes("تم ربط 3"));
    expect(linkedShown).toBe(true);
    await ui.unmount();
  });
});

describe("PurchasePage learnability (issue #94)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("teaches the first step on an empty purchase invoice", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PurchasePage />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const empty = container.querySelector('[data-testid="purchase-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("أضف أول منتج إلى الفاتورة");
    expect(empty?.textContent).toContain("اختر منتجاً من القائمة");
    const action = empty?.querySelector('[data-testid="purchase-open-picker"]');
    expect(action).not.toBeNull();
    expect(action?.textContent).toContain("إضافة منتج من القائمة");

    // checkout-only controls are not on an empty invoice
    expect(container.querySelector('[data-testid="purchase-checkout-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="purchase-save"]')).toBeNull();
    // the inline create path stays reachable (E2E testid)
    expect(container.querySelector('[data-testid="purchase-toggle-quick"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("PurchasePage party picker (issue 120)", () => {
  it("carries the picked supplier id onto the purchase invoice", async () => {
    supplierFixtures = [
      {
        id: "s-9",
        name: "مورد مسجّل",
        phone: "+213555123456",
        createdAt: "2026-10-01T10:00:00",
        stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 },
      },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PurchasePage />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    // pick the existing supplier from the filtered list
    const supplierInput = container.querySelector<HTMLInputElement>('[data-testid="purchase-supplier"]');
    if (supplierInput === null) throw new Error("missing supplier input");
    await act(async () => setValue(supplierInput, "مورد مسجّل"));
    for (let attempt = 0; attempt < 20 && container.querySelector('[data-testid="purchase-supplier-option"]') === null; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const option = container.querySelector<HTMLButtonElement>('[data-testid="purchase-supplier-option"]');
    if (option === null) throw new Error("missing supplier option");
    await act(async () => {
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // add a line through the quick-add form, then save
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const quickForm = container.querySelector<HTMLFormElement>('[data-testid="purchase-quick-form"]');
    if (quickForm === null) throw new Error("missing quick form");
    const quickName = quickForm.querySelector<HTMLInputElement>('[data-testid="quick-name"]');
    const quickQty = quickForm.querySelector<HTMLInputElement>('[data-testid="quick-qty"]');
    const quickCost = quickForm.querySelector<HTMLInputElement>('[data-testid="quick-cost"]');
    await act(async () => {
      if (quickName !== null) setValue(quickName, "منتج");
      if (quickQty !== null) setValue(quickQty, "1");
      if (quickCost !== null) setValue(quickCost, "100");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const categoryTrigger = quickForm.querySelector<HTMLElement>("button");
    if (categoryTrigger === null) throw new Error("missing category trigger");
    await chooseOption(categoryTrigger, "تصنيف");
    await act(async () => {
      quickForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(lastPurchaseInput?.counterpartyId).toBe("s-9");
    expect(lastPurchaseInput?.counterpartyName).toBe("مورد مسجّل");

    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
  });
});

describe("PurchasePage completion card (issue #159)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
    purchaseInvoiceResult = { id: "inv-1", invoiceNumber: "INV-1", remainingAmount: 0, counterpartyName: null };
  });

  afterEach(() => {
    queryClient.clear();
  });

  /** quick-add one item as a purchase line (the category comes from the mock) */
  async function addQuickLine(container: HTMLElement, name: string) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const quickForm = container.querySelector<HTMLFormElement>('[data-testid="purchase-quick-form"]')!;
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-name"]')!, name);
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-qty"]')!, "1");
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-cost"]')!, "100");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await chooseOption(quickForm.querySelector<HTMLElement>("button")!, "تصنيف");
    await act(async () => {
      quickForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("opens the saved purchase by id, keeps the proposal panel below, and restores the form", async () => {
    purchaseInvoiceResult = { id: "inv-77", invoiceNumber: "INV-77", remainingAmount: 12000, counterpartyName: "مورد" };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PurchasePage />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await addQuickLine(container, "منتج");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.querySelector('[data-testid="purchase-saved-number"]')?.textContent).toContain("INV-77");
    expect(container.querySelector('[data-testid="purchase-saved-debt"]')?.textContent).toContain("12000");
    // the actions open the saved invoice by its id, never its number
    expect(container.querySelector('[data-testid="purchase-open-invoice"]')?.getAttribute("href")).toContain("invoiceId=inv-77");
    expect(container.querySelector('[data-testid="purchase-print"]')?.getAttribute("href")).toContain("invoiceId=inv-77");

    // the proposal panel follows the completion card in the DOM
    const markup = container.innerHTML;
    expect(container.querySelector('[data-testid="link-proposal"]')).not.toBeNull();
    expect(markup.indexOf('data-testid="link-proposal"')).toBeGreaterThan(markup.indexOf('data-testid="purchase-saved-number"'));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-new"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="purchase-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="purchase-saved"]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("themes the purchase line quantity and cost inputs for dark mode (issue #160)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PurchasePage />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await addQuickLine(container, "منتج");
    for (const selector of ['input[aria-label*="الكمية"]', 'input[aria-label*="تكلفة"]']) {
      const field = container.querySelector<HTMLInputElement>(selector)!;
      expect(field.className).toContain("border-input");
      expect(field.className).toContain("bg-background");
      expect(field.className).toContain("focus-visible:ring-ring/40");
      expect(field.className).toContain("dark:bg-input/30");
    }
    await act(async () => root.unmount());
    container.remove();
  });
});

/**
 * #162/#171 — the purchase initial payment is a linked amount/percentage pair:
 * it defaults to the full cart total, follows cart edits, rejects an invalid
 * percentage, and omits a zero `initialPaid` (the api requires a positive one).
 */
describe("PurchasePage amount/percentage payment (#162/#171)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
    lastPurchaseInput = null;
    purchaseInvoiceResult = { id: "inv-1", invoiceNumber: "INV-1", remainingAmount: 0, counterpartyName: null };
  });

  afterEach(() => {
    queryClient.clear();
  });

  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  async function mountPurchase() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PurchasePage />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return { container, root };
  }

  /** quick-add one purchase line with the given quantity and unit cost */
  async function addQuickLine(container: HTMLElement, qty: string, cost: string) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const quickForm = container.querySelector<HTMLFormElement>('[data-testid="purchase-quick-form"]')!;
    await act(async () => {
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-name"]')!, "منتج");
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-qty"]')!, qty);
      setValue(quickForm.querySelector<HTMLInputElement>('[data-testid="quick-cost"]')!, cost);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await chooseOption(quickForm.querySelector<HTMLElement>("button")!, "تصنيف");
    await act(async () => {
      quickForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function save(container: HTMLElement) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  const amount = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')?.value;
  const percentage = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-testid="purchase-paid-percentage"]')?.value;
  const typePercentage = async (container: HTMLElement, value: string) => {
    await act(async () => setValue(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid-percentage"]')!, value));
  };

  it("defaults to the full total and links the percentage (#162)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    expect(amount(container)).toBe("100");
    expect(percentage(container)).toBe("100");
    await typePercentage(container, "50");
    expect(amount(container)).toBe("50");
    await act(async () => root.unmount());
    container.remove();
  });

  it("relinks the pair when the cart total changes (#171)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    await typePercentage(container, "50");
    expect(amount(container)).toBe("50");
    // the same item re-added at a larger quantity raises the total to 200
    await addQuickLine(container, "2", "100");
    expect(percentage(container)).toBe("50");
    expect(amount(container)).toBe("100");
    await act(async () => root.unmount());
    container.remove();
  });

  it("preserves an amount typed before the first line (#171)", async () => {
    const { container, root } = await mountPurchase();
    await act(async () => setValue(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')!, "40"));
    await addQuickLine(container, "1", "100");
    expect(amount(container)).toBe("40");
    expect(percentage(container)).toBe("40");
    await act(async () => root.unmount());
    container.remove();
  });

  it("resets the pair before the next purchase (#171)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    await act(async () => setValue(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')!, "40"));
    await save(container);
    expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-new"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(amount(container)).toBe("");
    // no reference on an empty cart: the percentage field is gone
    expect(percentage(container)).toBeUndefined();
    await act(async () => root.unmount());
    container.remove();
  });

  it("omits initialPaid for 0% and for a percentage that rounds to zero (#171)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    await typePercentage(container, "0");
    expect(amount(container)).toBe("0");
    await save(container);
    expect(lastPurchaseInput?.initialPaid).toBeUndefined();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-new"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // a tiny total: 1% of 1 rounds to 0 DZD and must still be omitted
    await addQuickLine(container, "1", "1");
    await typePercentage(container, "1");
    expect(amount(container)).toBe("0");
    await save(container);
    expect(lastPurchaseInput?.initialPaid).toBeUndefined();
    await act(async () => root.unmount());
    container.remove();
  });

  it("refuses an invalid percentage instead of saving it as unpaid (#171)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    await typePercentage(container, "12.5");
    expect(amount(container)).toBe("");
    expect(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid-percentage"]')?.getAttribute("aria-invalid")).toBe("true");
    await save(container);
    expect(container.querySelector('[data-testid="purchase-error"]')).not.toBeNull();
    expect(lastPurchaseInput).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });
});
