import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as routerModule from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/** Row shape the page reads from itemsList (see ItemListItem). */
interface FixtureItem {
  id: string;
  name: string;
  barcode: string | null;
  categoryId: string;
  categoryName: string | null;
  costPrice: number;
  sellingPrice: number;
  lowStockThreshold: number;
  stockOnHand: number;
  createdAt: string;
  updatedAt: string;
}

interface CategoryFixture {
  id: string;
  name: string;
}

/** Subset of the tanstack mutation options each call passes through. */
interface MutationOptions {
  onError?: (error: { message?: string }) => void;
}

/** Captured create payloads (plain and with opening stock). */
interface CapturedCreateInput {
  name?: string;
  costPrice?: number;
  sellingPrice?: number;
  stockOnHand?: number;
}

/** Captured inline-edit payload. */
interface CapturedUpdateInput {
  id?: string;
  name?: string;
  categoryId?: string;
  costPrice?: number;
  sellingPrice?: number;
  lowStockThreshold?: number;
}

/** Captured manual stock movement. */
interface CapturedStockInput {
  itemId?: string;
  delta?: number;
  unitCost?: number;
}

const categories: CategoryFixture[] = [
  { id: "cat-1", name: "زيوت" },
  { id: "cat-2", name: "فلاتر" },
];

function baseItem(over: Partial<FixtureItem> = {}): FixtureItem {
  return {
    id: "item-1",
    name: "بطارية",
    barcode: null,
    categoryId: "cat-1",
    categoryName: "زيوت",
    costPrice: 100,
    sellingPrice: 150,
    lowStockThreshold: 5,
    stockOnHand: 3,
    createdAt: "2026-09-01T10:00:00",
    updatedAt: "2026-09-01T10:00:00",
    ...over,
  };
}

let items: FixtureItem[] = [];
const createInputs: CapturedCreateInput[] = [];
const createWithStockInputs: CapturedCreateInput[] = [];
const updateInputs: CapturedUpdateInput[] = [];
const stockInputs: CapturedStockInput[] = [];
/** knobs the edit tests drive: reject, or hold the mutation open */
let updateFails = false;
let updateDeferred = false;
let resolveUpdate: (() => void) | null = null;

// The page reads/writes everything through orpc.*; the mock keeps the fixture
// as the single source of truth so an update + invalidate really refetches.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({ queryKey: ["categories"], queryFn: async () => ({ items: categories }) }),
    },
    itemsList: {
      // clone on each fetch so a refetch yields new object identities, exactly
      // like the JSON boundary — this is what exercises the prefill ref guard
      queryOptions: () => ({ queryKey: ["items"], queryFn: async () => ({ items: items.map((item) => ({ ...item })) }) }),
      queryKey: () => ["items"],
    },
    itemsLowStock: { queryKey: () => ["itemsLowStock"] },
    dashboardSummary: { queryKey: () => ["dashboardSummary"] },
    itemsCreate: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: CapturedCreateInput) => {
          createInputs.push(input);
          return { id: "created" };
        },
        ...opts,
      }),
    },
    itemsCreateWithStock: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: CapturedCreateInput) => {
          createWithStockInputs.push(input);
          return { id: "created-with-stock" };
        },
        ...opts,
      }),
    },
    itemsUpdate: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: CapturedUpdateInput) => {
          updateInputs.push(input);
          if (updateFails) throw new Error("ITEM_ERROR");
          const commit = () => {
            const existing = items.find((item) => item.id === input.id);
            if (existing) {
              // mirror the real write: the refetched list must show the change
              Object.assign(existing, {
                name: input.name,
                categoryId: input.categoryId,
                costPrice: input.costPrice,
                sellingPrice: input.sellingPrice,
                lowStockThreshold: input.lowStockThreshold,
                categoryName: categories.find((category) => category.id === input.categoryId)?.name ?? null,
              });
            }
            return existing ?? { id: input.id };
          };
          if (updateDeferred) {
            return new Promise<FixtureItem | { id?: string }>((resolve) => {
              resolveUpdate = () => resolve(commit());
            });
          }
          return commit();
        },
        ...opts,
      }),
    },
    stockAddManual: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: CapturedStockInput) => {
          stockInputs.push(input);
          return { id: "movement-1" };
        },
        ...opts,
      }),
    },
    // ItemPickerDialog evaluates this query even while closed.
    catalogSearch: {
      queryOptions: () => ({ queryKey: ["catalogSearch"], queryFn: async () => ({ matches: [], exact: null }), enabled: false }),
    },
  },
  rpcClient: { catalogSearch: async () => ({ exact: null }) },
}));

// ItemList renders a Link; the mount has no router tree, so render a plain
// anchor and spread the real module so sibling files keep RouterProvider.
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  Link: (props: { children?: ReactNode; className?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return (
      <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>
        {children}
      </a>
    );
  },
  useParams: () => ({}),
}));

const { ItemsPage } = await import("./items");

interface MountedPage {
  container: HTMLElement;
  queryClient: QueryClient;
}

let mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement; queryClient: QueryClient }> = [];

function el<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element: ${selector}`);
  return found;
}

function inputByTestId(testId: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing input: ${testId}`);
  return found;
}

/** The table row whose first/any cell is exactly this text. */
function rowByCell(name: string): HTMLTableRowElement {
  const cell = Array.from(document.querySelectorAll("td")).find((candidate) => candidate.textContent === name);
  if (cell === undefined) throw new Error(`no cell with text ${name}`);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`cell ${name} has no row`);
  return row;
}

/** React controlled inputs need the native value setter + an input event. */
function setInput(testId: string, value: string) {
  const input = inputByTestId(testId);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(testId: string) {
  act(() => {
    el<HTMLButtonElement>(`[data-testid="${testId}"]`).click();
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}

async function waitFor(check: () => boolean, attempts = 120): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await flush();
  }
  throw new Error("condition not met within timeout");
}

async function mount(): Promise<MountedPage> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mounted.push({ root, container, queryClient });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ItemsPage />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => document.querySelector('[data-testid="stock-after-cell"]') !== null);
  return { container, queryClient };
}

async function openAddTab(): Promise<void> {
  click("items-tab-add");
  await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);
}

/** Base UI arms selection on pointerdown, then commits on click; the async act
 * wraps the floating-positioner updates these dispatch. */
async function openSelectPopup(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function chooseOption(label: string) {
  await waitFor(() => Array.from(document.querySelectorAll("[role='option']")).some((option) => option.textContent?.includes(label)));
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (option === undefined) throw new Error(`option not found: ${label}`);
  await act(async () => {
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  items = [baseItem(), baseItem({ id: "item-2", name: "فلتر زيت", categoryId: "cat-2", categoryName: "فلاتر", costPrice: 200, sellingPrice: 300, stockOnHand: 0 })];
  createInputs.length = 0;
  createWithStockInputs.length = 0;
  updateInputs.length = 0;
  stockInputs.length = 0;
  updateFails = false;
  updateDeferred = false;
  resolveUpdate = null;
  document.body.innerHTML = "";
});

afterEach(() => {
  const roots = mounted;
  mounted = [];
  for (const entry of roots) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  document.body.innerHTML = "";
});

describe("items page tabs", () => {
  it("defaults to the products table and hides the add panel", async () => {
    await mount();
    expect(el<HTMLElement>("#items-panel-products").hidden).toBe(false);
    expect(el<HTMLElement>("#items-panel-add").hidden).toBe(true);
    expect(el<HTMLButtonElement>("#items-tab-products").getAttribute("aria-selected")).toBe("true");
  });

  it("wires tabs to panels and supports Arrow, Home and End", async () => {
    await mount();
    const productsTab = el<HTMLButtonElement>("#items-tab-products");
    const addTab = el<HTMLButtonElement>("#items-tab-add");

    expect(productsTab.getAttribute("aria-controls")).toBe("items-panel-products");
    expect(addTab.getAttribute("aria-controls")).toBe("items-panel-add");
    expect(productsTab.getAttribute("tabindex")).toBe("0");
    expect(addTab.getAttribute("tabindex")).toBe("-1");
    expect(el<HTMLElement>("#items-panel-products").getAttribute("aria-labelledby")).toBe("items-tab-products");
    expect(el<HTMLElement>("#items-panel-add").getAttribute("role")).toBe("tabpanel");

    // End jumps to the last tab (add)
    act(() => {
      productsTab.focus();
      productsTab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    await waitFor(() => addTab.getAttribute("aria-selected") === "true");
    expect(document.activeElement).toBe(addTab);
    expect(addTab.getAttribute("tabindex")).toBe("0");

    // ArrowLeft moves back to products
    act(() => {
      addTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await waitFor(() => productsTab.getAttribute("aria-selected") === "true");
    expect(document.activeElement).toBe(productsTab);

    // Home always returns to the first tab
    act(() => {
      addTab.focus();
      addTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    await waitFor(() => productsTab.getAttribute("aria-selected") === "true");
  });

  it("keeps an add-form draft when switching tabs and back", async () => {
    await mount();
    await openAddTab();
    setInput("item-name", "مسودة-محفوظة");
    click("items-tab-products");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === true);
    click("items-tab-add");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);
    expect(inputByTestId("item-name").value).toBe("مسودة-محفوظة");
  });
});

describe("add item form opening stock", () => {
  it("uses the plain create path for blank and zero stock", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية جديدة");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    setInput("initial-stock", "");

    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]?.stockOnHand).toBeUndefined();
    expect(createWithStockInputs.length).toBe(0);

    // fields reset after success; a deliberate zero still means plain create
    await waitFor(() => inputByTestId("item-name").value === "");
    setInput("item-name", "بطارية صفر");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    setInput("initial-stock", "0");
    click("item-save");
    await waitFor(() => createInputs.length === 2);
    expect(createWithStockInputs.length).toBe(0);
  });

  it("uses create-with-stock for a positive number, in one submit", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية بمخزون");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    setInput("initial-stock", "7");

    click("item-save");
    await waitFor(() => createWithStockInputs.length === 1);
    expect(createWithStockInputs[0]).toMatchObject({ name: "بطارية بمخزون", stockOnHand: 7 });
    expect(createInputs.length).toBe(0);
  });

  it("rejects negative or fractional opening stock without calling the server", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية خاطئة");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    for (const bad of ["-3", "2.5", "abc"]) {
      setInput("initial-stock", bad);
      click("item-save");
      await waitFor(() => document.querySelector('[data-testid="form-error"]') !== null);
    }
    expect(createInputs.length).toBe(0);
    expect(createWithStockInputs.length).toBe(0);
  });
});

describe("stock form prefill", () => {
  it("shows the selling price and prefills the cost from the selected item", async () => {
    await mount();
    await openAddTab();

    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");
    expect(el<HTMLElement>('[data-testid="stock-selling-price"]').textContent).toContain("150");

    await openSelectPopup(el<HTMLElement>('[data-testid="stock-item"]'));
    await chooseOption("فلتر زيت");

    await waitFor(() => inputByTestId("stock-unit-cost").value === "200");
    expect(el<HTMLElement>('[data-testid="stock-selling-price"]').textContent).toContain("300");
  });

  it("submits a hand-edited unit cost and survives a refetch", async () => {
    const { queryClient } = await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");

    // the prefilled value stays editable
    setInput("stock-unit-cost", "999");
    setInput("stock-delta", "4");

    // a background refetch must not clobber the typed value
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["items"] });
    });
    expect(inputByTestId("stock-unit-cost").value).toBe("999");

    click("stock-save");
    await waitFor(() => stockInputs.length === 1);
    expect(stockInputs[0]).toMatchObject({ itemId: "item-1", delta: 4, unitCost: 999 });
  });
});

describe("inline item edit", () => {
  it("updates name, category, prices and threshold and reflects them in the row", async () => {
    await mount();

    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);

    setInput("edit-name", "بطارية جديدة");
    setInput("edit-cost", "120");
    setInput("edit-sell", "180");
    setInput("edit-threshold", "9");

    await openSelectPopup(el<HTMLElement>('[data-testid="edit-category"]'));
    await chooseOption("فلاتر");

    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    expect(updateInputs[0]).toMatchObject({
      id: "item-1",
      name: "بطارية جديدة",
      categoryId: "cat-2",
      costPrice: 120,
      sellingPrice: 180,
      lowStockThreshold: 9,
    });

    await waitFor(() => Array.from(document.querySelectorAll("td")).some((cell) => cell.textContent === "بطارية جديدة"));
    const row = rowByCell("بطارية جديدة");
    expect(row.textContent).toContain("180");
    expect(row.textContent).toContain("فلاتر");
  });

  it("blocks an empty name without calling the server", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "   ");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(updateInputs.length).toBe(0);
  });

  it("blocks a non-positive selling price without calling the server", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-sell"]') !== null);
    setInput("edit-sell", "0");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(updateInputs.length).toBe(0);
  });

  it("cancel discards the draft and returns focus to the edit control", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "لن-يُحفظ");
    click("edit-cancel");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') === null);
    expect(updateInputs.length).toBe(0);
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="edit-item-item-1"]'));
  });

  it("shows the server error and stays in edit mode", async () => {
    await mount();
    updateFails = true;
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(document.querySelector('[data-testid="edit-name"]')).not.toBeNull();
    expect(updateInputs.length).toBe(1);
  });

  it("does not close a row opened while another save is in flight", async () => {
    await mount();
    updateDeferred = true;
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "الصف الأول");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);

    // open the second row while row 1's save is still pending
    click("edit-item-item-2");
    await waitFor(() => inputByTestId("edit-name").value === "فلتر زيت");

    // let row 1's save settle; row 2's draft must stay open
    await act(async () => {
      resolveUpdate?.();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(document.querySelector('[data-testid="edit-name"]')).not.toBeNull();
    expect(inputByTestId("edit-name").value).toBe("فلتر زيت");
  });
});
