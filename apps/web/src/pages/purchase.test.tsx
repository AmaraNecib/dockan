import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { Item } from "@dokan/contracts";

import { toArabicIndic, toExtendedArabicIndic } from "../tests/arabic-digits";
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
let lastPurchaseInput: { counterpartyId?: string; counterpartyName?: string; initialPaid?: number; notes?: string; lines?: Array<{ itemId: string; quantity: number; unitPrice: number }> } | null = null;
/** clears the recorder without narrowing the module variable at the call site */
function clearPurchaseRecorder() {
  lastPurchaseInput = null;
}
/** every itemsCreate the mocked quick-add performed, in order (issue #146) */
const createdItems: Array<{ name: string; categoryId: string }> = [];
/** the full itemsCreate input per quick-add, for field-level assertions (#225) */
const createdItemInputs: Array<{ name: string; categoryId: string; costPrice?: number; sellingPrice?: number; lowStockThreshold?: number }> = [];
/** the ranked results the picker's search answers with (#257) */
let catalogMatches: Array<{ item: Item; category: null; matchedBy: "NAME" }> = [];
/**
 * When set, every itemsCreate waits for it to settle before answering, so a test
 * can leave a create in flight and act while it is pending (#257).
 */
let itemsCreateGate: Promise<void> | null = null;
let releaseItemsCreate: (() => void) | null = null;
/** when set, an itemsCreate that gets past its gate rejects (#257 round 2) */
let itemsCreateFails = false;
/** when set, an invoicesCreate that gets past its gate rejects (#257 round 6) */
let invoiceCreateFails = false;
/**
 * When set, every invoicesCreate waits for it to settle before answering, so a
 * test can leave the SAVE in flight and act while it is pending (#257 round 4).
 */
let invoiceCreateGate: Promise<void> | null = null;
let releaseInvoiceCreate: (() => void) | null = null;

/** a catalog item for the picker's search results (#257) */
function catalogItem(id: string, name: string, costPrice = 400, sellingPrice = 1000): Item {
  return {
    id,
    name,
    barcode: null,
    categoryId: "cat-1",
    costPrice,
    sellingPrice,
    lowStockThreshold: 0,
    stockOnHand: 0,
    createdAt: "2026-10-01T10:00:00",
    updatedAt: "2026-10-01T10:00:00",
  };
}
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
    // invalidated after a save; the page must not throw on the refresh path
    itemsAll: { queryKey: () => ["itemsAll"] },
    catalogSearch: {
      queryOptions: () => ({
        queryKey: ["catalogSearch"],
        queryFn: async () => ({ matches: catalogMatches, exact: null }),
      }),
    },
    itemsCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: PanelMutationOptions) => ({
        mutationFn: async (input: { name: string; categoryId: string; costPrice?: number; sellingPrice?: number; lowStockThreshold?: number }) => {
          // a gated write stays pending until the test releases it (#257)
          if (itemsCreateGate !== null) await itemsCreateGate;
          if (itemsCreateFails) throw new Error("itemsCreate failed");
          createdItems.push({ name: input.name, categoryId: input.categoryId });
          createdItemInputs.push(input);
          // Fixture fiction: one item id per distinct name. The real server has no
          // name uniqueness, so a same-name quick-add creates a second item. Here
          // it lets a test say "re-adding the same name replaces that line" while
          // two names give two distinct lines.
          return { id: `item-${input.name}`, name: input.name, costPrice: 100, sellingPrice: 150 };
        },
        ...opts,
      }),
    },
    invoicesCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: PanelMutationOptions) => ({
        mutationFn: async (input: { counterpartyId?: string; counterpartyName?: string; initialPaid?: number }) => {
          // the payload is the snapshot the owner sent, so it is recorded before
          // the gate: a test reads what the in-flight request carries (#257 round 4)
          lastPurchaseInput = input;
          // a gated save stays pending until the test releases it (#257 round 4)
          if (invoiceCreateGate !== null) await invoiceCreateGate;
          if (invoiceCreateFails) throw new Error("invoicesCreate failed");
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

// the mocked quick-add records every create, so clear it before every test:
// a test that asserts create counts or item ids must not see another test's
// calls. Clearing in place keeps any alias valid.
beforeEach(() => {
  createdItems.length = 0;
  createdItemInputs.length = 0;
  // a gated or matched create must never leak into the next test
  catalogMatches = [];
  itemsCreateGate = null;
  releaseItemsCreate = null;
  itemsCreateFails = false;
  invoiceCreateFails = false;
  // a gated save must never leak into the next test either
  invoiceCreateGate = null;
  releaseInvoiceCreate = null;
});

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
    empty: () => container.querySelector<HTMLElement>('[data-testid="link-proposal-empty"]'),
    emptyState: () => container.textContent?.includes(i18n.t("purchasesProposalEmpty")) ?? false,
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

  it("explains an empty link pool with no invented action (#96)", async () => {
    fixture = { invoiceId: "inv-1", items: [] };
    const ui = await mountPanel(queryClient);
    expect(await ui.waitFor(() => ui.empty() !== null)).toBe(true);

    const empty = ui.empty()!;
    expect(empty.textContent).toContain(i18n.t("purchasesProposalEmpty"));
    // the panel keeps its own heading; the explanation invents no control
    expect(document.querySelectorAll('[data-testid="link-proposal"] h3')).toHaveLength(1);
    expect(empty.querySelector("button, a")).toBeNull();

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
    // non-vacuous: a blocked save would also leave `lastPurchaseInput` null
    expect(lastPurchaseInput).not.toBeNull();
    expect(lastPurchaseInput?.initialPaid).toBeUndefined();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-new"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // a tiny total: 1% of 1 rounds to 0 DZD and must still be omitted
    await addQuickLine(container, "1", "1");
    await typePercentage(container, "1");
    expect(amount(container)).toBe("0");
    // clear the recorder so the second save must send its OWN request
    clearPurchaseRecorder();
    await save(container);
    expect(lastPurchaseInput).not.toBeNull();
    expect(lastPurchaseInput?.initialPaid).toBeUndefined();
    await act(async () => root.unmount());
    container.remove();
  });

  it("refuses an amount above the cart total before sending (#171)", async () => {
    const { container, root } = await mountPurchase();
    await addQuickLine(container, "1", "100");
    await act(async () => setValue(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')!, "200"));
    await save(container);
    expect(container.querySelector('[data-testid="purchase-error"]')).not.toBeNull();
    expect(lastPurchaseInput).toBeNull();
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

/**
 * #146 — the purchase quantity field is the shared quantity *draft* now, so it
 * behaves exactly like sale's: a cleared or unreadable draft stays visible and
 * resolves to zero, and submit refuses it instead of silently keeping the
 * previous number (the drift this ticket fixes).
 */
describe("PurchasePage quantity draft (#146)", () => {
  let queryClient: QueryClient;
  /** roots created by this block, so a test that throws still tears down */
  let mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
    lastPurchaseInput = null;
    mounted = [];
    purchaseInvoiceResult = { id: "inv-1", invoiceNumber: "INV-1", remainingAmount: 0, counterpartyName: null };
  });

  afterEach(async () => {
    const entries = mounted;
    mounted = [];
    for (const entry of entries) {
      // a test that already tore down its own root is fine; React tolerates the
      // second unmount, and this guarantees cleanup when the body threw
      await act(async () => entry.root.unmount());
      entry.container.remove();
    }
    queryClient.clear();
  });

  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** mount the page with the category list resolved */
  async function mountPage() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
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

  const quickForm = (container: HTMLElement) => container.querySelector<HTMLFormElement>('[data-testid="purchase-quick-form"]');
  /** the quick-add category control; its rendered label shows the current pick */
  const categoryTrigger = (container: HTMLElement) => quickForm(container)?.querySelector<HTMLElement>('[data-slot="select-trigger"]') ?? null;

  /** open the inline create form */
  async function toggleQuick(container: HTMLElement) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** fill the open form's item fields; the category is left exactly as it is */
  async function fillQuick(container: HTMLElement, name: string, qty: string, cost: string) {
    const form = quickForm(container);
    if (form === null) throw new Error("the quick-add form is not open");
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>('[data-testid="quick-name"]')!, name);
      setValue(form.querySelector<HTMLInputElement>('[data-testid="quick-qty"]')!, qty);
      setValue(form.querySelector<HTMLInputElement>('[data-testid="quick-cost"]')!, cost);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function submitQuick(container: HTMLElement) {
    await act(async () => {
      quickForm(container)?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /** mount the page and land one purchase line through the quick-add */
  async function mountWithLine(qty: string, cost: string) {
    const page = await mountPage();
    await toggleQuick(page.container);
    await fillQuick(page.container, "منتج", qty, cost);
    await act(async () => {
      await chooseOption(categoryTrigger(page.container)!, "تصنيف");
    });
    await submitQuick(page.container);
    return page;
  }

  const quantityField = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[aria-label*="الكمية"]')!;
  const totalText = (container: HTMLElement) => container.querySelector('[data-testid="purchase-total"]')?.textContent ?? "";
  /** the rendered total as a number, so a zero check cannot pass on a substring */
  const totalAmount = (container: HTMLElement) => Number(totalText(container).match(/\d+/)?.[0] ?? Number.NaN);
  const save = async (container: HTMLElement) => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  it("keeps a cleared draft cleared and refuses to save it, instead of silently keeping the stale quantity", async () => {
    const { container, root } = await mountWithLine("2", "1200");
    expect(quantityField(container).value).toBe("2");
    expect(totalText(container)).toContain("2400");

    // the drift: the field must stay empty, exactly like sale — the old
    // `Number(event.target.value)` handler snapped it back to "2"
    await act(async () => setValue(quantityField(container), ""));
    expect(quantityField(container).value).toBe("");
    // the line is still there and resolves to zero, like sale
    expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
    expect(totalAmount(container)).toBe(0);

    await save(container);
    expect(container.querySelector('[data-testid="purchase-error"]')?.textContent).toContain("أدخل كمية صحيحة");
    expect(lastPurchaseInput).toBeNull();

    // typing a fresh value after the cleared draft still works
    await act(async () => setValue(quantityField(container), "3"));
    expect(quantityField(container).value).toBe("3");
    expect(totalText(container)).toContain("3600");
    await act(async () => root.unmount());
    container.remove();
  });

  it("blames the unusable quantity, not the payment, when a typed payment survives a cleared quantity (greptile round 2)", async () => {
    const { container, root } = await mountWithLine("2", "1200");
    expect(totalText(container)).toContain("2400");

    // type a valid payment: the pair's source becomes "amount", so clearing the
    // quantity keeps 1200 in the amount field while the total falls to zero
    await act(async () => setValue(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')!, "1200"));
    expect(totalAmount(container)).toBe(2400);
    await act(async () => setValue(quantityField(container), ""));
    expect(quantityField(container).value).toBe("");
    expect(totalAmount(container)).toBe(0);

    await save(container);
    // the quantity is the real problem; the payment-vs-zero-total check must not
    // shadow it. Without the fix the page says «purchasesInvalidPaid» here.
    const message = container.querySelector('[data-testid="purchase-error"]')?.textContent ?? "";
    expect(message).toContain(i18n.t("purchasesInvalidQuantity"));
    expect(message).not.toContain(i18n.t("purchasesInvalidPaid"));
    expect(lastPurchaseInput).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps an unreadable or zero draft visible and resolves it to zero, exactly like sale", async () => {
    const { container, root } = await mountWithLine("2", "1200");
    for (const draft of ["abc", "2.5", "-3", "0"]) {
      await act(async () => setValue(quantityField(container), draft));
      expect(quantityField(container).value).toBe(draft);
      expect(totalAmount(container)).toBe(0);
      await save(container);
      expect(container.querySelector('[data-testid="purchase-error"]')).not.toBeNull();
      expect(lastPurchaseInput).toBeNull();
    }
    await act(async () => root.unmount());
    container.remove();
  });

  it("sends a valid draft as a whole number and keeps the per-line unitPrice (money math pinned)", async () => {
    const { container, root } = await mountWithLine("2", "1200");
    expect(totalText(container)).toContain("2400");
    await save(container);
    expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the unit-cost field's previous value for an unreadable draft and reads a cleared field as zero", async () => {
    const { container } = await mountWithLine("2", "1200");
    const cost = container.querySelector<HTMLInputElement>('input[aria-label*="تكلفة"]')!;
    expect(cost.value).toBe("1200");
    expect(totalText(container)).toContain("2400");

    // a cleared cost is an explicit zero, exactly as before #146
    await act(async () => setValue(cost, ""));
    expect(cost.value).toBe("0");
    expect(totalText(container)).toContain("0");

    await act(async () => setValue(cost, "900"));
    expect(cost.value).toBe("900");
    expect(totalText(container)).toContain("1800");

    // an unreadable draft keeps the previous cost instead of billing zero
    await act(async () => setValue(cost, "abc"));
    expect(cost.value).toBe("900");
    expect(totalText(container)).toContain("1800");
  });

  it("refuses an over-cap quick-add quantity instead of landing a line that resolves to zero", async () => {
    const { container } = await mountWithLine("1000001", "1200");
    expect(container.querySelector('[data-testid="purchase-error"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(0);
    expect(lastPurchaseInput).toBeNull();
  });

  it("creates two items in a row from a single category pick (greptile round 1)", async () => {
    const { container } = await mountPage();
    await toggleQuick(container);
    await fillQuick(container, "منتج واحد", "1", "100");
    // the one category pick that must serve both creates
    await act(async () => {
      await chooseOption(categoryTrigger(container)!, "تصنيف");
    });
    await submitQuick(container);

    expect(createdItems).toHaveLength(1);
    expect(createdItems[0]!.categoryId).toBe("cat-1");
    // a successful create closes the form
    expect(quickForm(container)).toBeNull();

    // reopen and create a second item without touching the category, which the
    // old handler kept and the first shared reset dropped
    await toggleQuick(container);
    // the trigger carries only the selected label plus its chevron, so this
    // fails if the pick was dropped back to the «—» placeholder
    const trigger = categoryTrigger(container);
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("تصنيف");
    expect(trigger?.textContent).not.toContain("—");
    // and the fields that must NOT survive are still cleared: the quantity is
    // back to its seed and the previous name is gone
    expect(quickForm(container)?.querySelector<HTMLInputElement>('[data-testid="quick-qty"]')?.value).toBe("1");
    expect(quickForm(container)?.querySelector<HTMLInputElement>('[data-testid="quick-name"]')?.value).toBe("");

    await fillQuick(container, "منتج ثانٍ", "1", "100");
    await submitQuick(container);

    // two distinct items landed as two draft lines
    expect(createdItems).toHaveLength(2);
    expect(createdItems[1]).toEqual({ name: "منتج ثانٍ", categoryId: "cat-1" });
    expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(2);
    // no itemsChooseCategory: the second create never asked for a pick
    expect(container.querySelector('[data-testid="purchase-error"]')).toBeNull();

    // re-creating the SAME name is the same item, so it replaces its line
    // instead of appending a third
    await toggleQuick(container);
    await fillQuick(container, "منتج واحد", "1", "100");
    await submitQuick(container);
    expect(createdItems).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(2);
  });

  it("saves a line at the quantity cap and refuses one above it, pinning the payload", async () => {
    const { container } = await mountWithLine("2", "1200");

    await act(async () => setValue(quantityField(container), "1000001"));
    await save(container);
    expect(container.querySelector('[data-testid="purchase-error"]')?.textContent).toContain(i18n.t("purchasesInvalidQuantity"));
    expect(lastPurchaseInput).toBeNull();

    await act(async () => setValue(quantityField(container), "1000000"));
    await save(container);
    expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 1_000_000, unitPrice: 1200 }]);
  });

  it("bills an Arabic-Indic quantity the same as its ASCII value (#198 decision)", async () => {
    const { container } = await mountWithLine("2", "1200");
    await act(async () => setValue(quantityField(container), "٥"));
    await save(container);
    expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 5, unitPrice: 1200 }]);
  });

  it("quick-adds with Arabic-Indic cost, sell and threshold exactly like ASCII (#225)", async () => {
    const { container } = await mountPage();
    await toggleQuick(container);
    // the ASCII twin of 100 is the `fillQuick` cost; sell and threshold are the
    // remaining two loose `Number` fields on the form
    await fillQuick(container, "منتج بأرقام", "1", toArabicIndic("100"));
    const form = quickForm(container);
    if (form === null) throw new Error("the quick-add form is not open");
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>('input[name="quickSell"]')!, toExtendedArabicIndic("200"));
      setValue(form.querySelector<HTMLInputElement>('input[name="quickThreshold"]')!, toArabicIndic("5"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await chooseOption(categoryTrigger(container)!, "تصنيف");
    });
    await submitQuick(container);

    expect(createdItemInputs[0]).toMatchObject({ name: "منتج بأرقام", costPrice: 100, sellingPrice: 200, lowStockThreshold: 5 });
  });

  it("lands an Arabic-Indic quick-add cost on the purchase line it adds (#225)", async () => {
    // the create form has TWO cost readers: the item it saves and the line it
    // lands (`addItem`, purchase.tsx:107). The line's unitPrice pins the second.
    const { container } = await mountWithLine("1", toArabicIndic("1200"));
    await save(container);
    expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 1, unitPrice: 1200 }]);
  });

  it("refuses a multi-line cart with an emptied line and saves once it is fixed", async () => {
    const { container } = await mountPage();
    await toggleQuick(container);
    await fillQuick(container, "منتج أ", "2", "1200");
    await act(async () => {
      await chooseOption(categoryTrigger(container)!, "تصنيف");
    });
    await submitQuick(container);
    // the second create keeps the category from the first pick
    await toggleQuick(container);
    await fillQuick(container, "منتج ب", "3", "900");
    await submitQuick(container);
    expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(2);

    // clear the FIRST line: the cart is refused and nothing is sent
    const quantities = container.querySelectorAll<HTMLInputElement>('input[aria-label*="الكمية"]');
    await act(async () => setValue(quantities[0]!, ""));
    await save(container);
    expect(container.querySelector('[data-testid="purchase-error"]')?.textContent).toContain(i18n.t("purchasesInvalidQuantity"));
    expect(lastPurchaseInput).toBeNull();

    // fixing the first line leaves the second usable: the save carries both
    // lines with their per-line costs
    await act(async () => setValue(quantities[0]!, "2"));
    await save(container);
    expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    expect(lastPurchaseInput?.lines).toEqual([
      { itemId: "item-منتج أ", quantity: 2, unitPrice: 1200 },
      { itemId: "item-منتج ب", quantity: 3, unitPrice: 900 },
    ]);
  });

  /**
   * #257 — create the product on the line the owner is already editing. The
   * whole point of the shortcut is that the quantity and unit cost he typed on
   * that line survive it; losing them is the failure mode that makes it not
   * worth having.
   */
  describe("inline product on the purchase line (#257)", () => {
    const lineQty = (container: HTMLElement, itemId: string) => container.querySelector<HTMLInputElement>(`input[name="quantity-${itemId}"]`);
    const lineCost = (container: HTMLElement, itemId: string) => container.querySelector<HTMLInputElement>(`input[name="unitCost-${itemId}"]`);
    const createRow = (container: HTMLElement) => container.querySelector<HTMLTableRowElement>('[data-testid="purchase-line-create-row"]');
    const lineForm = (container: HTMLElement) => container.querySelector<HTMLFormElement>('[data-testid="purchase-line-product-form"]');
    const lineCategoryTrigger = (container: HTMLElement) => lineForm(container)?.querySelector<HTMLElement>('[data-slot="select-trigger"]') ?? null;

    /** forget the creates made so far, so a test's assertions see only its own */
    function forgetCreates() {
      createdItems.length = 0;
      createdItemInputs.length = 0;
    }

    /**
     * Mount the page with one line whose quantity and cost the owner typed, and
     * forget the quick-add create that put it there.
     */
    async function mountWithTypedLine(qty: string, cost: string) {
      const page = await mountWithLine(qty, cost);
      forgetCreates();
      return page;
    }

    /** open the inline create form on one line */
    async function openCreate(container: HTMLElement, itemId: string) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid="purchase-line-new-${itemId}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    /** fill the open line form; the category is left exactly as it is */
    async function fillCreate(container: HTMLElement, values: { name?: string; sell?: string }) {
      const form = lineForm(container);
      if (form === null) throw new Error("the line create form is not open");
      await act(async () => {
        if (values.name !== undefined) setValue(form.querySelector<HTMLInputElement>('[data-testid="line-product-name"]')!, values.name);
        if (values.sell !== undefined) setValue(form.querySelector<HTMLInputElement>('[data-testid="line-product-sell"]')!, values.sell);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    async function chooseLineCategory(container: HTMLElement, label: string) {
      await act(async () => {
        await chooseOption(lineCategoryTrigger(container)!, label);
      });
    }

    async function submitCreate(container: HTMLElement) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    /**
     * Type a query into the dialog that is already open and pick the single
     * ranked match. The trigger differs per caller (a line's own picker, or the
     * append action), so only this half is shared.
     */
    async function pickInOpenPicker(container: HTMLElement, query: string) {
      const dialog = container.querySelector<HTMLElement>('[data-testid="picker-dialog"]');
      if (dialog === null) throw new Error("the picker did not open");
      await act(async () => {
        setValue(dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!, query);
      });
      // the dialog debounces its search by 150 ms; poll for the rendered option
      // rather than betting on a fixed sleep, and fail by name if it never comes
      let option: HTMLButtonElement | null = null;
      for (let attempt = 0; attempt < 40 && option === null; attempt += 1) {
        option = dialog.querySelector<HTMLButtonElement>('[role="option"] button');
        if (option === null) await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      }
      if (option === null) throw new Error("the picker's search never rendered its option");
      await act(async () => {
        option?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    /** open a line's catalog picker and pick the single ranked match */
    async function pickForLine(container: HTMLElement, itemId: string, query: string) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid="purchase-line-pick-${itemId}"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await pickInOpenPicker(container, query);
    }

    /** open the append picker (a new line) and pick the single ranked match */
    async function pickAppend(container: HTMLElement, query: string) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="purchase-open-picker"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await pickInOpenPicker(container, query);
    }

    /** submit the open line form and leave its write in flight */
    async function submitCreateInFlight(container: HTMLElement) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    /** release a gated itemsCreate and let the page settle */
    async function releaseCreate() {
      // a test that forgot to open a gate would otherwise go green without ever
      // settling the write it claims to release
      if (releaseItemsCreate === null) throw new Error("no itemsCreate gate is open to release");
      await act(async () => {
        releaseItemsCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    /** press Save and leave the invoice write in flight */
    async function saveInFlight(container: HTMLElement) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    /** release a gated invoicesCreate and let the page settle */
    async function releaseSaved() {
      // a test that forgot to open a gate would otherwise go green without ever
      // settling the save it claims to release
      if (releaseInvoiceCreate === null) throw new Error("no invoicesCreate gate is open to release");
      await act(async () => {
        releaseInvoiceCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    const saveButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-testid="purchase-save"]');
    const costField = (container: HTMLElement, itemId: string) => container.querySelector<HTMLInputElement>(`input[name="unitCost-${itemId}"]`);

    it("creates the product on the line and keeps the quantity and unit cost the owner typed", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      expect(totalText(container)).toContain("2400");

      await openCreate(container, "item-منتج");
      expect(createRow(container)).not.toBeNull();
      // the form names the cost it will record, so the price is not a mystery
      expect(createRow(container)?.textContent).toContain("1200");
      await fillCreate(container, { name: "منتج جديد" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);

      // one product, priced from the line's own unit cost; the selling price
      // falls back to it exactly as the products page and quick-add default
      expect(createdItemInputs).toHaveLength(1);
      expect(createdItemInputs[0]).toMatchObject({ name: "منتج جديد", categoryId: "cat-1", costPrice: 1200, sellingPrice: 1200 });

      // the form closed and the line now points at the created product
      expect(createRow(container)).toBeNull();
      expect(lineQty(container, "item-منتج")).toBeNull();
      expect(lineCost(container, "item-منتج")).toBeNull();
      expect(container.querySelector('[data-testid="purchase-lines"]')?.textContent).toContain("منتج جديد");
      // …and the typed values survived the replace
      expect(lineQty(container, "item-منتج جديد")?.value).toBe("2");
      expect(lineCost(container, "item-منتج جديد")?.value).toBe("1200");
      expect(totalText(container)).toContain("2400");
      // the caret is on the line's quantity: the cost is already typed
      expect(document.activeElement).toBe(lineQty(container, "item-منتج جديد"));

      // the save carries one line, pointing at the product just created
      await save(container);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج جديد", quantity: 2, unitPrice: 1200 }]);
    });

    it("uses a typed selling price for the product it creates", async () => {
      const { container } = await mountWithTypedLine("1", "900");
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج بسعر", sell: "1400" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);

      expect(createdItemInputs[0]).toMatchObject({ name: "منتج بسعر", costPrice: 900, sellingPrice: 1400 });
      expect(lineQty(container, "item-منتج بسعر")?.value).toBe("1");
    });

    it("refuses a nameless create without calling the server, and keeps the form on its line", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      await openCreate(container, "item-منتج");
      // the category is picked, so the name is the only thing missing
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);

      expect(container.querySelector('[data-testid="line-product-error"]')?.textContent).toContain(i18n.t("itemsNameRequired"));
      expect(createdItems).toHaveLength(0);
      expect(createRow(container)).not.toBeNull();
      expect(lineQty(container, "item-منتج")?.value).toBe("2");
      expect(totalText(container)).toContain("2400");
    });

    it("refuses a create with no category picked, naming the category", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "بلا تصنيف" });
      await submitCreate(container);

      expect(container.querySelector('[data-testid="line-product-error"]')?.textContent).toContain(i18n.t("itemsChooseCategory"));
      expect(createdItems).toHaveLength(0);
    });

    it("keeps the line as it was when the create is abandoned mid-flight", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      // gate only from here: the mount's own line create must not be held
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج مهجور" });
      await chooseLineCategory(container, "تصنيف");

      // submit, then leave the form while the write is still in flight
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-cancel"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(createRow(container)).toBeNull();

      await act(async () => {
        releaseItemsCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // the product was created — a write is a server fact — but the line the
      // owner left must not be re-pointed by the abandoned attempt
      expect(createdItems).toHaveLength(1);
      expect(container.querySelector('[data-testid="purchase-lines"]')?.textContent).not.toContain("منتج مهجور");
      expect(lineQty(container, "item-منتج")?.value).toBe("2");
      expect(lineCost(container, "item-منتج")?.value).toBe("1200");
      expect(lineQty(container, "item-منتج مهجور")).toBeNull();
      // an abandoned attempt's failure or success is not the owner's to read
      expect(container.querySelector('[data-testid="line-product-error"]')).toBeNull();
    });

    it("changes the product on a line from its own picker, keeping the typed values", async () => {
      catalogMatches = [{ item: catalogItem("other-1", "منتج آخر", 700), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("3", "1200");
      expect(totalText(container)).toContain("3600");

      await pickForLine(container, "item-منتج", "منتج آخر");

      expect(container.querySelector('[data-testid="picker-dialog"]')).toBeNull();
      expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
      expect(lineQty(container, "other-1")?.value).toBe("3");
      // the cost the owner typed is his, so a replace never rewrites it
      expect(lineCost(container, "other-1")?.value).toBe("1200");
      expect(totalAmount(container)).toBe(3600);
      // the caret follows the line the pick re-pointed
      expect(document.activeElement).toBe(lineQty(container, "other-1"));
    });

    it("keeps the line when the owner re-picks the product it already holds", async () => {
      // the line's own picker can be pointed at the very product the line shows;
      // the survivor lookup then matches the line itself, and dropping it would
      // delete the quantity and cost the owner typed (review round 1, F1)
      catalogMatches = [{ item: catalogItem("item-منتج", "منتج", 100, 150), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("3", "1200");

      await pickForLine(container, "item-منتج", "منتج");

      expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
      expect(lineQty(container, "item-منتج")?.value).toBe("3");
      // the fixture's own cost (100) never replaces the typed one (1200)
      expect(lineCost(container, "item-منتج")?.value).toBe("1200");
      expect(totalAmount(container)).toBe(3600);
    });

    it("creates the product from a line whose unit cost is still zero", async () => {
      const { container } = await mountWithTypedLine("2", "100");
      // the owner has not typed the purchase price yet: a cleared cost reads as 0
      await act(async () => setValue(lineCost(container, "item-منتج")!, ""));
      expect(lineCost(container, "item-منتج")?.value).toBe("0");

      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج بلا سعر" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);

      // the shortcut is not blocked on a price the owner is about to type: the
      // product carries the line's current cost, and the invoice line's own
      // movement re-derives it from the ledger once the cost is typed
      expect(createdItemInputs[0]).toMatchObject({ name: "منتج بلا سعر", costPrice: 0, sellingPrice: 0 });
      expect(lineQty(container, "item-منتج بلا سعر")?.value).toBe("2");

      await act(async () => setValue(lineCost(container, "item-منتج بلا سعر")!, "900"));
      expect(lineCost(container, "item-منتج بلا سعر")?.value).toBe("900");
      expect(totalAmount(container)).toBe(1800);
    });

    it("refuses an unreadable selling price instead of sending it to the server", async () => {
      const { container } = await mountWithTypedLine("1", "900");
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج بسعر غلط", sell: "abc" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);

      expect(container.querySelector('[data-testid="line-product-error"]')?.textContent).toContain(i18n.t("itemsSellInvalid"));
      expect(createdItems).toHaveLength(0);
    });

    it("collapses the form when the line's own button is pressed again, without creating", async () => {
      const { container } = await mountWithTypedLine("1", "900");
      const button = () => container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-new-item-منتج"]');

      await openCreate(container, "item-منتج");
      const form = lineForm(container);
      expect(form).not.toBeNull();
      // a disclosure button names the region it controls while it is expanded
      expect(button()?.getAttribute("aria-expanded")).toBe("true");
      expect(button()?.getAttribute("aria-controls")).toBe(form?.id);

      // pressing the open button again must collapse it, not wipe a draft and
      // leave the row expanded
      await act(async () => {
        button()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(createRow(container)).toBeNull();
      expect(button()?.getAttribute("aria-expanded")).toBe("false");
      expect(createdItems).toHaveLength(0);

      // reopening starts from an empty name rather than the abandoned draft
      await openCreate(container, "item-منتج");
      expect(lineForm(container)?.querySelector<HTMLInputElement>('[data-testid="line-product-name"]')?.value).toBe("");
    });

    it("returns the caret to the line's create button when the form is cancelled", async () => {
      const { container } = await mountWithTypedLine("1", "900");
      await openCreate(container, "item-منتج");
      expect(document.activeElement).toBe(lineForm(container)?.querySelector('[data-testid="line-product-name"]') ?? null);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-cancel"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(createRow(container)).toBeNull();
      // the form unmounted out from under the caret, so the trigger takes it back
      expect(document.activeElement).toBe(container.querySelector('[data-testid="purchase-line-new-item-منتج"]'));
    });

    it("lands the caret on the lines region when a cancel races the in-flight save (round 5, F1)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      // the form is open BEFORE the save: only a line-create SUBMIT holds the
      // save back, so an open form leaves it live — this is the state round 4's
      // freeze then catches the cancel in
      await openCreate(container, "item-منتج");
      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      await saveInFlight(container);

      const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-new-item-منتج"]');
      // round 4's freeze is exactly what makes the trigger unfocusable: a
      // disabled button cannot take focus, and `.focus()` on one is a no-op
      expect(trigger()?.disabled).toBe(true);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-cancel"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Cancel stays enabled on purpose (round 2: a hung write must not trap the
      // owner), so the form is gone — but its trigger cannot take the caret back,
      // and dropping the owner on the document body restarts his tab order at the
      // top of the page. The request falls back to the lines region instead: it is
      // the only enabled anchor in the frozen draft and the frozen status line
      // states why its controls are dead.
      expect(createRow(container)).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(container.querySelector('[data-testid="purchase-lines"]'));
      // …and the region carries the frozen line's reason with it, so the landing
      // is announced as "the lines, and here is why they are dead" rather than as
      // an unnamed box. `role="status"` announced the line when it mounted; a
      // description is what a screen reader reads at the moment of this focus
      // move (round-5 review, a11y)
      const region = container.querySelector('[data-testid="purchase-lines"]');
      expect(region?.getAttribute("aria-describedby")).toBe(container.querySelector('[data-testid="purchase-lines-frozen"]')?.id);
      expect(region?.getAttribute("aria-label")).toBe(i18n.t("purchasesLinesTitle"));
      // …and the region SHOWS that it holds the caret: a script-issued focus
      // never matches `:focus-visible`, so this landing was silent for a sighted
      // keyboard user. The ring is written on `focus:` on purpose, and the e2e
      // asserts its computed width (#257 round 6, F2).
      expect(region?.className).toContain("focus:outline-2");

      await releaseSaved();
      // the save lands and replaces the whole draft with its success card, as it
      // does for every successful save. Focusing the region is what this test is
      // about; the region then unmounts with the draft and the caret falls back to
      // the document, which is the page's own save-completed swap and not a second
      // move this freeze makes.
      expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    });

    it("hands the caret back to the line's create button when the frozen save settles (round 6, F2)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      // the form is open before the save, so round 4's freeze catches the cancel
      await openCreate(container, "item-منتج");
      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      // …and the save FAILS: a failed save keeps the draft, so the trigger the
      // cancel asked for really does come back
      invoiceCreateFails = true;
      await saveInFlight(container);

      const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-new-item-منتج"]');
      expect(trigger()?.disabled).toBe(true);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-cancel"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // during the freeze the caret has to stand somewhere visible (round 5)
      expect(document.activeElement).toBe(container.querySelector('[data-testid="purchase-lines"]'));

      await act(async () => {
        releaseInvoiceCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

      // the freeze lifted and the owner is still standing where it left him, so
      // the request it could not honor is re-applied instead of leaving him on
      // a region he never chose
      expect(container.querySelector('[data-testid="purchase-error"]')).not.toBeNull();
      expect(trigger()?.disabled).toBe(false);
      expect(document.activeElement).toBe(trigger());
    });

    it("abandons a create when the owner opens another line's form mid-flight", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      await toggleQuick(container);
      await fillQuick(container, "منتج ب", "1", "100");
      await submitQuick(container);
      forgetCreates();

      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج أ مهجور" });
      await chooseLineCategory(container, "تصنيف");
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // retarget while the write is in flight
      await openCreate(container, "item-منتج ب");
      // retargeting abandons the placement, so the save is free again at once —
      // the second form is not the answer the invoice is waiting for
      expect(saveButton(container)?.disabled).toBe(false);
      await act(async () => {
        releaseItemsCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // the product exists, but neither line was re-pointed and the new form is
      // still the one on screen
      expect(createdItems).toHaveLength(1);
      expect(lineQty(container, "item-منتج")?.value).toBe("2");
      expect(lineQty(container, "item-منتج ب")?.value).toBe("1");
      expect(createRow(container)).not.toBeNull();
      expect(container.querySelector('[data-testid="line-product-error"]')).toBeNull();
    });

    it("drops the create form with the line when the owner deletes it", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      await toggleQuick(container);
      await fillQuick(container, "منتج ب", "1", "100");
      await submitQuick(container);
      forgetCreates();

      await openCreate(container, "item-منتج");
      expect(createRow(container)).not.toBeNull();
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("removeRow")} منتج"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // the form lives in the deleted line's row, so it goes with it
      expect(createRow(container)).toBeNull();
      expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
      // …and the surviving line still creates
      await openCreate(container, "item-منتج ب");
      await fillCreate(container, { name: "منتج ج" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);
      expect(createdItems).toHaveLength(1);
      expect(lineQty(container, "item-منتج ج")?.value).toBe("1");
    });

    it("does not let a create in flight re-point the line that re-adds its deleted item (round 2, F1)", async () => {
      // the picker caches its ranked set under one query key, so it is in place
      // before the page mounts, like every other picker test here
      catalogMatches = [{ item: catalogItem("item-منتج", "منتج"), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("2", "1200");
      // a second line keeps the append action on screen after the delete
      await toggleQuick(container);
      await fillQuick(container, "منتج ب", "1", "100");
      await submitQuick(container);
      forgetCreates();

      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج جديد" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);

      // the owner deletes the line the create is pointed at…
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("removeRow")} منتج"]`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // …and the save is free again: the placement went with the line
      expect(saveButton(container)?.disabled).toBe(false);
      // …and reads that same catalog item in again before the write answers
      await pickAppend(container, "منتج");

      // the abandoned create must not bring its form back on the new line
      expect(createRow(container)).toBeNull();

      await releaseCreate();

      // the new line keeps the product it was added as; the abandoned create
      // wrote its product but placed nothing
      expect(createdItems).toHaveLength(1);
      expect(lineQty(container, "item-منتج")?.value).toBe("1");
      expect(costField(container, "item-منتج")?.value).toBe("400");
      // the name cell itself is the added product, not the created one (the row's
      // own button reads «منتج جديد» too, so a text match cannot tell them apart)
      expect(container.querySelector('[data-testid="purchase-line-pick-item-منتج"]')?.textContent).toBe("منتج");
      expect(container.querySelector('[data-testid="purchase-line-pick-item-منتج جديد"]')).toBeNull();

      // and the invoice that follows books that product, not the created one
      await save(container);
      expect(lastPurchaseInput?.lines).toEqual([
        { itemId: "item-منتج ب", quantity: 1, unitPrice: 100 },
        { itemId: "item-منتج", quantity: 1, unitPrice: 400 },
      ]);
    });

    it("blocks the invoice save while a line create is in flight (round 2, F2)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج جديد" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);

      // the line still names the product the owner is replacing, so saving here
      // would stock that product instead of the one being created
      expect(saveButton(container)?.disabled).toBe(true);
      // …and the disabled control states its reason instead of being a dead end
      expect(container.querySelector('[data-testid="purchase-save-pending"]')?.textContent).toContain(i18n.t("purchasesLineCreatePending"));
      // the click a user would try must not book the invoice, whatever the
      // mechanism that stops it
      await save(container);
      expect(container.querySelector('[data-testid="purchase-saved"]')).toBeNull();
      expect(lastPurchaseInput).toBeNull();

      await releaseCreate();

      // the create landed, so the save is free again and carries the new product
      expect(saveButton(container)?.disabled).toBe(false);
      await save(container);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج جديد", quantity: 2, unitPrice: 1200 }]);
    });

    it("frees the invoice save when the owner cancels the create in flight (round 2, F2)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج مهجور" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);
      expect(saveButton(container)?.disabled).toBe(true);

      // the explicit cancel abandons the placement, so the write still in flight
      // is no longer an answer the invoice has to wait for
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="line-product-cancel"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(saveButton(container)?.disabled).toBe(false);

      await save(container);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);

      // the abandoned write still lands as a server fact, and re-points nothing
      await releaseCreate();
      expect(createdItems).toHaveLength(1);
      expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    });

    it("lets only one create be in flight, so the save gate holds a single slot (round 2, F2)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      // the page-level quick-add form stays open; its own create must not be a
      // second placement racing the line create for the same gate
      await toggleQuick(container);
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج أ" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);

      // `createItem.isPending` disables both create submits, so the pending state
      // is a single slot and the attempt match in its updater is insurance rather
      // than a path a user can walk
      expect(container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-quick-form"] button[type="submit"]')?.disabled).toBe(true);

      await releaseCreate();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')).toBeNull();
      expect(saveButton(container)?.disabled).toBe(false);
    });

    it("frees the save when the create fails while the form is still on its line (round 2, F2)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      itemsCreateFails = true;

      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج فاشل" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);
      expect(saveButton(container)?.disabled).toBe(true);

      await releaseCreate();

      // nothing was placed and nothing is still owed, so the form reports the
      // failure and the invoice is free to save the line as it stands
      expect(createdItems).toHaveLength(0);
      expect(container.querySelector('[data-testid="line-product-error"]')?.textContent).toContain(i18n.t("errorGeneric"));
      expect(createRow(container)).not.toBeNull();
      expect(saveButton(container)?.disabled).toBe(false);
      expect(lineQty(container, "item-منتج")?.value).toBe("2");
      expect(container.querySelector('[data-testid="purchase-save-pending"]')).toBeNull();
      await save(container);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);
    });

    it("refuses to re-point a line while the invoice save is in flight (round 4, F1)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      await saveInFlight(container);

      // the request carries the product the line held when the owner pressed Save
      expect(saveButton(container)?.disabled).toBe(true);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);

      // the line's own create form is one control that can replace that product:
      // it must not open, and the picker beside it must not re-point the line
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-new-item-منتج"]')?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-pick-item-منتج"]')?.disabled).toBe(true);
      await openCreate(container, "item-منتج");
      expect(createRow(container)).toBeNull();

      // the line the request serialised is the line on screen, so what the owner
      // sees and what the server books cannot diverge
      expect(lineQty(container, "item-منتج")?.value).toBe("2");
      expect(container.querySelector('[data-testid="purchase-line-pick-item-منتج"]')?.textContent).toBe("منتج");

      await releaseSaved();

      // the save that landed is the one that went out: the product the owner chose
      // at the moment of saving
      expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    });

    it("refuses a line-create submit that no disabled button produced (round 4, F1 belt)", async () => {
      // the form is open and typed BEFORE the save: this is the state the race
      // needs, and the state the submit button's `disabled` has to cover
      const { container } = await mountWithTypedLine("2", "1200");
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج سبق" });
      await chooseLineCategory(container, "تصنيف");

      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      await saveInFlight(container);
      // the request is out, carrying the product the line held when Save was pressed
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);

      // the handler behind the control is the belt: a submit no disabled button
      // could produce must not start a create against a request already in flight
      await act(async () => {
        lineForm(container)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(createdItems).toHaveLength(0);
      // …and the control itself is dead, so no user reaches the belt at all
      expect(lineForm(container)?.querySelector<HTMLButtonElement>('[data-testid="line-product-save"]')?.disabled).toBe(true);

      await releaseSaved();
      expect(createdItems).toHaveLength(0);
    });

    it("refuses a catalog pick that would re-point a line under the in-flight save (round 4, F1 belt)", async () => {
      // the picker's ranked set is cached under one query key, so it is in place
      // before the page mounts, like every other picker test here
      catalogMatches = [{ item: catalogItem("item-بديل", "بديل", 700), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("2", "1200");
      // the line's picker is open when the save starts: this is the other control
      // that can replace the product, and the dialog's backdrop does not stop a
      // Save click that no mouse reaches (#257 round 4)
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-pick-item-منتج"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      await saveInFlight(container);
      expect(lastPurchaseInput?.lines).toEqual([{ itemId: "item-منتج", quantity: 2, unitPrice: 1200 }]);

      // the pick lands while the request is out: the line must keep the product the
      // request carries, not the picked one
      await pickInOpenPicker(container, "بديل");
      expect(container.querySelector('[data-testid="purchase-line-pick-item-بديل"]')).toBeNull();
      expect(lineQty(container, "item-منتج")?.value).toBe("2");

      await releaseSaved();
      // the save lands and the line it booked is still the one the request carried
      // (the pick was refused, so nothing was replaced under it)
      expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="purchase-line-pick-item-بديل"]')).toBeNull();
    });

    it("disables a line's own picker while that line's create is in flight (round 6, F1)", async () => {
      catalogMatches = [{ item: catalogItem("other-1", "منتج آخر", 700), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("3", "1200");
      const picker = () => container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-pick-item-منتج"]');
      expect(picker()?.disabled).toBe(false);

      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج جديد" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreateInFlight(container);

      // the line's product is about to move, so a pick made through this button
      // would name the id the landing removes and be dropped on the floor
      expect(picker()?.disabled).toBe(true);
      await act(async () => {
        picker()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.querySelector('[data-testid="picker-dialog"]')).toBeNull();

      await releaseCreate();
      // the window is over: the button is live again, pointed at the new product
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-pick-item-منتج جديد"]')?.disabled).toBe(false);
    });

    it("keeps a pick made from a picker a landing create replaced (round 6, F1 belt)", async () => {
      catalogMatches = [{ item: catalogItem("other-1", "منتج آخر", 700), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("3", "1200");
      itemsCreateGate = new Promise<void>((resolve) => {
        releaseItemsCreate = resolve;
      });
      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج جديد" });
      await chooseLineCategory(container, "تصنيف");

      // the picker is open for the line the create will replace — the state a
      // submit that no mouse reaches produces, because the dialog is modal
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="purchase-line-pick-item-منتج"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        lineForm(container)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // the create is now in flight and a mouse could not have opened this
      // dialog any more (the button is dead for the window) — this is the belt
      // route: the dialog was open first, the submit came from behind it
      await releaseCreate();

      // the line is the create's product and the open dialog followed it there:
      // picking now must re-point that row, not an id the landing removed
      expect(lineQty(container, "item-منتج جديد")?.value).toBe("3");
      expect(container.querySelector('[data-testid="picker-dialog"]')).not.toBeNull();

      await pickInOpenPicker(container, "منتج آخر");

      expect(container.querySelector('[data-testid="picker-dialog"]')).toBeNull();
      expect(lineQty(container, "other-1")?.value).toBe("3");
      expect(lineCost(container, "other-1")?.value).toBe("1200");
    });

    it("freezes the rest of the invoice draft while the save is in flight (round 4, F1)", async () => {
      const { container } = await mountWithTypedLine("2", "1200");
      await toggleQuick(container);
      // before the save every one of these is live
      expect(lineQty(container, "item-منتج")?.disabled).toBe(false);
      expect(lineCost(container, "item-منتج")?.disabled).toBe(false);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-open-picker"]')?.disabled).toBe(false);

      invoiceCreateGate = new Promise<void>((resolve) => {
        releaseInvoiceCreate = resolve;
      });
      await saveInFlight(container);

      // every control the request already serialised is read-only, so the draft on
      // screen cannot drift from the payload the server is booking
      expect(lineQty(container, "item-منتج")?.disabled).toBe(true);
      expect(lineCost(container, "item-منتج")?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("removeRow")} منتج"]`)?.disabled).toBe(true);
      // the notes ride in the same request, so they are frozen with the lines
      expect(container.querySelector<HTMLInputElement>('input[name="notes"]')?.disabled).toBe(true);
      // …and so are the two fields round 2/3 already froze, now by the same value
      expect(container.querySelector<HTMLInputElement>('[data-testid="purchase-supplier"]')?.disabled).toBe(true);
      expect(container.querySelector<HTMLInputElement>('[data-testid="purchase-paid"]')?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-open-picker"]')?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="purchase-quick-form"] button[type="submit"]')?.disabled).toBe(true);
      // …and the frozen table says so instead of being a dead end
      expect(container.querySelector('[data-testid="purchase-lines-frozen"]')?.textContent).toContain(i18n.t("purchasesSaveInFlight"));

      await releaseSaved();
      expect(container.querySelector('[data-testid="purchase-saved"]')).not.toBeNull();
    });

    it("folds a line into the line that already holds the picked product", async () => {
      // the picker's search is cached by query key, so the ranked set is in place
      // before the dialog's observer reads it
      catalogMatches = [{ item: catalogItem("item-منتج ب", "منتج ب", 900), category: null, matchedBy: "NAME" }];
      const { container } = await mountWithTypedLine("2", "1200");
      // a second line, so the picked product already has somewhere to land
      await toggleQuick(container);
      await fillQuick(container, "منتج ب", "3", "900");
      await submitQuick(container);
      expect(container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(2);

      await pickForLine(container, "item-منتج", "منتج ب");

      // one line per item: the quantities folded into the line that had it
      const rows = container.querySelectorAll('[data-testid="purchase-lines"] tbody tr');
      expect(rows).toHaveLength(1);
      expect(lineQty(container, "item-منتج ب")?.value).toBe("5");
      expect(totalText(container)).toContain("4500");
    });

    it("keeps the category pick for the next line create, and no leftover name", async () => {
      const { container } = await mountWithTypedLine("1", "100");
      // a second line, so a second line create can be opened afterwards
      await toggleQuick(container);
      await fillQuick(container, "منتج ب", "1", "100");
      await submitQuick(container);
      forgetCreates();

      await openCreate(container, "item-منتج");
      await fillCreate(container, { name: "منتج ج" });
      await chooseLineCategory(container, "تصنيف");
      await submitCreate(container);
      expect(createdItems).toHaveLength(1);

      await openCreate(container, "item-منتج ب");
      // the one category pick serves the next product: the trigger carries the
      // selected label, not the «—» placeholder
      expect(lineCategoryTrigger(container)?.textContent).toContain("تصنيف");
      expect(lineCategoryTrigger(container)?.textContent).not.toContain("—");
      // …while the previous product's name does not follow the owner around
      expect(lineForm(container)?.querySelector<HTMLInputElement>('[data-testid="line-product-name"]')?.value).toBe("");
    });
  });
});
