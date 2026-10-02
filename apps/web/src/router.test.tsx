import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "./lib/i18n";
import { ThemeProvider } from "./lib/theme";

interface InvoiceMutationOptions {
  onSuccess?: (invoice: { invoiceNumber: string }) => void;
  onError?: (error: { message: string }) => void;
}

interface ItemMutationOptions {
  onSuccess?: (item: { id: string }) => void;
  onError?: (error: { message: string }) => void;
}

/** PartyPicker create options (issue 120); the picker passes callbacks per call. */
interface PartyCreateMutationOptions {
  onSuccess?: (party: { id: string; name: string; phone: string | null; createdAt: string }) => void;
  onError?: (error: { message?: string }) => void;
}

let invoiceMutationResolves = true;

// SalePage resolves queries and mutations through orpc; the route test drives
// the real form without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    // the shell's pending-returns badge query (issue #118)
    returnsPendingCount: {
      queryOptions: () => ({ queryKey: ["returnsPendingCount"], queryFn: async () => ({ count: 0 }) }),
    },
    categoriesList: {
      queryOptions: () => ({
        queryKey: ["categories"],
        queryFn: async () => ({ items: [{ id: "cat-1", name: "تصنيف" }] }),
      }),
    },
    catalogSearch: {
      queryOptions: () => ({
        queryKey: ["catalogSearch"],
        queryFn: async () => ({ items: [], exact: null }),
        enabled: false,
      }),
    },
    itemsCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => ({ id: "item-1", name: "منتج", sellingPrice: 150, costPrice: 100 }),
        ...opts,
      }),
    },
    itemsCreateWithStock: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => ({ id: "item-1" }),
        ...opts,
      }),
    },
    invoicesCreate: {
      mutationOptions: (opts?: InvoiceMutationOptions) => ({
        mutationFn: () =>
          invoiceMutationResolves
            ? Promise.resolve({ invoiceNumber: "1" })
            : new Promise<never>(() => {}),
        ...opts,
      }),
    },
    itemsList: { queryKey: () => ["items"] },
    itemsLowStock: { queryKey: () => ["itemsLowStock"] },
    // PartyPicker (issue 120) mounts on the sale form and needs both lists
    customersList: {
      queryOptions: () => ({ queryKey: ["customers"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["customers"],
    },
    suppliersList: {
      queryOptions: () => ({ queryKey: ["suppliers"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["suppliers"],
    },
    customersCreate: {
      mutationOptions: (opts?: PartyCreateMutationOptions) => ({ mutationFn: async () => ({ id: "c-1", name: "زبون", phone: null, createdAt: "" }), ...opts }),
    },
    suppliersCreate: {
      mutationOptions: (opts?: PartyCreateMutationOptions) => ({ mutationFn: async () => ({ id: "s-1", name: "مورد", phone: null, createdAt: "" }), ...opts }),
    },
  },
  rpcClient: {
    catalogSearch: async () => ({ exact: null }),
    preferencesGet: async () => ({ values: {} }),
    preferencesSet: async (input: { key: string; value: string }) => ({ key: input.key, value: input.value }),
  },
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
  authClient: { signOut: async () => {} },
}));

const { routeTree } = await import("./router");

interface MountedRoute {
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  queryClient: QueryClient;
}

let mounted: MountedRoute[] = [];

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByTestId(testId: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing input: ${testId}`);
  return el;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing button: ${testId}`);
  return el;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error("timed out waiting for the expected UI");
}

async function mountSaleRoute(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/sale"] }),
  });
  mounted.push({ root, container, queryClient });
  await act(async () => {
    root.render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
  });
  await waitFor(() => document.querySelector('[data-testid="sale-form"]') !== null);
}

beforeEach(() => {
  invoiceMutationResolves = true;
});

afterEach(async () => {
  const roots = mounted;
  mounted = [];
  for (const entry of roots) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
    entry.queryClient.clear();
  }
  document.body.innerHTML = "";
});

describe("sale route reset (header New Sale action)", () => {
  it("asks before discarding an unsaved draft, then restarts the form", async () => {
    await mountSaleRoute();

    await act(async () => typeInto(inputByTestId("sale-customer"), "زبون مؤقت"));
    expect(inputByTestId("sale-customer").value).toBe("زبون مؤقت");

    await act(async () => buttonByTestId("new-sale-button").click());
    await waitFor(() => document.querySelector('[data-testid="new-sale-discard-confirm"]') !== null);

    // the draft is untouched until the user confirms the discard
    expect(inputByTestId("sale-customer").value).toBe("زبون مؤقت");

    await act(async () => buttonByTestId("new-sale-discard-confirm").click());
    await waitFor(() => inputByTestId("sale-customer").value === "");
    expect(inputByTestId("sale-customer").value).toBe("");
  });

  it("restarts without a prompt when the form is empty", async () => {
    await mountSaleRoute();

    await act(async () => buttonByTestId("new-sale-button").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(document.querySelector('[data-testid="new-sale-discard-confirm"]')).toBeNull();
    expect(inputByTestId("sale-customer").value).toBe("");
  });

  it("does not reset while a save is pending", async () => {
    invoiceMutationResolves = false;
    await mountSaleRoute();

    await act(async () => buttonByTestId("sale-quick-add").click());
    await waitFor(() => document.querySelector('[data-testid="sale-quick-form"]') !== null);
    // the trigger must name the category it will save into, not merely render
    await waitFor(() => {
      const category = document.querySelector('[data-testid="sale-quick-category"]');
      return category !== null && category.textContent?.includes("تصنيف") === true;
    });

    const quickInput = (name: string): HTMLInputElement => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="sale-quick-form"] [name="${name}"]`);
      if (input === null) throw new Error(`missing quick-add input: ${name}`);
      return input;
    };
    await act(async () => {
      typeInto(quickInput("quickName"), "منتج سريع");
      typeInto(quickInput("quickCost"), "100");
      typeInto(quickInput("quickSell"), "150");
    });

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="sale-quick-form"] button[type="submit"]',
    );
    if (submit === null) throw new Error("missing quick-add submit");
    await act(async () => submit.click());
    await waitFor(() => document.querySelector('[data-testid="sale-lines"]') !== null);

    await act(async () => buttonByTestId("sale-save").click());
    await waitFor(() => buttonByTestId("new-sale-button").disabled);
    expect(buttonByTestId("new-sale-button").disabled).toBe(true);
  });

  it("treats an in-progress quick-add item as a draft", async () => {
    await mountSaleRoute();

    await act(async () => buttonByTestId("sale-quick-add").click());
    await waitFor(() => document.querySelector('[data-testid="sale-quick-name"]') !== null);
    await act(async () => typeInto(inputByTestId("sale-quick-name"), "منتج قيد الإنشاء"));

    await act(async () => buttonByTestId("new-sale-button").click());
    await waitFor(() => document.querySelector('[data-testid="new-sale-discard-confirm"]') !== null);

    // the quick-add draft is untouched until the user confirms the discard
    expect(inputByTestId("sale-quick-name").value).toBe("منتج قيد الإنشاء");

    await act(async () => buttonByTestId("new-sale-discard-confirm").click());
    await waitFor(() => document.querySelector('[data-testid="sale-quick-form"]') === null);
  });

  it("keeps an in-progress sale when the sidebar Sale link is used", async () => {
    await mountSaleRoute();

    // the header action starts a fresh sale and leaves `fresh` in the URL
    await act(async () => buttonByTestId("new-sale-button").click());
    await waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('a[href^="/sale"]');
      return link !== null && link.getAttribute("href")?.includes("fresh") === true;
    });

    await act(async () => typeInto(inputByTestId("sale-customer"), "زبون محفوظ"));

    const saleLink = document.querySelector<HTMLAnchorElement>('a[href^="/sale"]');
    if (saleLink === null) throw new Error("missing sidebar sale link");
    await act(async () => saleLink.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(inputByTestId("sale-customer").value).toBe("زبون محفوظ");
  });
});
