import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { chooseOption } from "../tests/select-driver";

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
let lastPurchaseInput: { counterpartyId?: string; counterpartyName?: string } | null = null;

// The page renders the completion card's router Links; mirror the seam the
// other page tests use so PurchasePage is testable without a router mount.
mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: import("react").ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>{children}</a>;
  },
  useParams: () => ({}),
}));

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
        mutationFn: async (input: { counterpartyId?: string; counterpartyName?: string }) => {
          lastPurchaseInput = input;
          return { id: "inv-1", invoiceNumber: "INV-1", remainingAmount: 0, counterpartyName: null };
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
