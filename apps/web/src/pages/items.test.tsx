import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as routerModule from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

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
  lowStockThreshold?: number;
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
/** holds a create-with-stock save open so a stale settlement is observable */
let createWithStockDeferred = false;
let resolveCreateWithStock: (() => void) | null = null;
/** holds the itemsList refetch open so the stale-cache window is observable */
let itemsGate: Promise<void> | null = null;
let releaseItemsGate: (() => void) | null = null;

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
      queryOptions: () => ({
        queryKey: ["items"],
        queryFn: async () => {
          // the stale-cache test holds this open to make the window observable
          if (itemsGate !== null) await itemsGate;
          return { items: items.map((item) => ({ ...item })), total: items.length };
        },
      }),
      queryKey: () => ["items"],
    },
    itemsAll: {
      queryOptions: () => ({
        queryKey: ["itemsAll"],
        queryFn: async () => {
          // the stock form prefills from this read; the stale-cost tests gate it
          // exactly like the table read so the in-flight window is observable
          if (itemsGate !== null) await itemsGate;
          return { items: items.map((item) => ({ ...item })) };
        },
      }),
      queryKey: () => ["itemsAll"],
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
        // SAFETY: the resolver is stored by the deferred branch and invoked by
        // the stale-save test; the immediate branch keeps every other test fast
        mutationFn: async (input: CapturedCreateInput) => {
          createWithStockInputs.push(input);
          if (createWithStockDeferred) {
            return new Promise<{ id: string }>((resolve) => {
              resolveCreateWithStock = () => resolve({ id: "created-with-stock" });
            });
          }
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
              // mirror the real write: only the fields the client sent land, so
              // a partial patch cannot blank the ones it left out
              if (input.name !== undefined) existing.name = input.name;
              if (input.categoryId !== undefined) {
                existing.categoryId = input.categoryId;
                existing.categoryName = categories.find((category) => category.id === input.categoryId)?.name ?? null;
              }
              if (input.costPrice !== undefined) existing.costPrice = input.costPrice;
              if (input.sellingPrice !== undefined) existing.sellingPrice = input.sellingPrice;
              if (input.lowStockThreshold !== undefined) existing.lowStockThreshold = input.lowStockThreshold;
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
      queryKey: () => ["catalogSearch"],
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

/** The first fixture row, for tests that mutate the shared fixture. */
function firstFixtureItem(): FixtureItem {
  const first = items[0];
  if (first === undefined) throw new Error("no fixture item");
  return first;
}

/** React controlled inputs need the native value setter + an input event. */
function setInputElement(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setInput(testId: string, value: string) {
  setInputElement(inputByTestId(testId), value);
}

/** The add-form's threshold input has no testid; it is the only one by that name. */
function setInputByName(name: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`missing input: ${name}`);
  setInputElement(input, value);
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

/** Let React Query's notification/render flush inside an awaited act block. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
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
  createWithStockDeferred = false;
  resolveCreateWithStock = null;
  itemsGate = null;
  releaseItemsGate = null;
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

    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
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
    expect(createInputs[0]).toMatchObject({ name: "بطارية جديدة", costPrice: 100, sellingPrice: 180 });
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

  it("takes the 5 default for a blanked threshold, including a mark-only paste (#244)", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية حد افتراضي");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    // a bidi mark is Cf, not whitespace: the raw gate read a chosen threshold
    // and then the strict reader refused it instead of taking the default
    setInputByName("itemThreshold", "\u200f");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "بطارية حد افتراضي", lowStockThreshold: 5 });
  });

  it("keeps an explicit 0 threshold distinct from a blank default (#244)", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية بلا تنبيه");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    // `draftBlank("0")` is false, so 0 stays 0 (no alert) — only a blank/mark-only
    // draft takes the 5 default. One keystroke apart, so pin both.
    setInputByName("itemThreshold", "0");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "بطارية بلا تنبيه", lowStockThreshold: 0 });
  });

  it("rejects a non-numeric cost without calling the server", async () => {
    await mount();
    await openAddTab();
    setInput("item-name", "بطارية تكلفة خاطئة");
    setInput("item-cost", "12,5");
    setInput("item-sell", "180");
    click("item-save");
    await waitFor(() => document.querySelector('[data-testid="form-error"]') !== null);
    expect(el<HTMLElement>('[data-testid="form-error"]').textContent).toContain("تكلفة");
    expect(createInputs.length).toBe(0);
    expect(createWithStockInputs.length).toBe(0);
  });

  it("rejects an opening stock too large to represent exactly", async () => {
    await mount();
    await openAddTab();

    setInput("item-name", "بطارية ضخمة");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    // 2^53 + 1 parses to 2^53, so the contract would persist a quantity the
    // operator never typed
    setInput("initial-stock", "9007199254740993");
    click("item-save");
    await waitFor(() => document.querySelector('[data-testid="form-error"]') !== null);
    expect(el<HTMLElement>('[data-testid="form-error"]').textContent).toContain("مخزون");
    expect(createWithStockInputs.length).toBe(0);
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
      // the stock-specific message proves this value was rejected, not a stale error
      expect(el<HTMLElement>('[data-testid="form-error"]').textContent).toContain("مخزون");
      expect(createInputs.length).toBe(0);
      expect(createWithStockInputs.length).toBe(0);
    }
  });
});

describe("scan create-with-stock requires the opening quantity (issue #125)", () => {
  /** wedge-scan a code: the mocked catalogSearch never resolves an exact item */
  async function scanUnknown(code: string) {
    await act(async () => {
      for (const character of code) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** take the unknown dialog's stocked path and land on the seeded add form */
  async function openStockSeedForm(barcode: string): Promise<void> {
    await mount();
    await scanUnknown(barcode);
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create-stock");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);
    expect(inputByTestId("item-barcode").value).toBe(barcode);
  }

  it("refuses a blank opening quantity and creates nothing", async () => {
    await openStockSeedForm("UNKNOWN-STOCK-1");

    setInput("item-name", "ممسوح بلا كمية");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    click("item-save");
    await waitFor(() => document.querySelector('[data-testid="form-error"]') !== null);

    expect(el<HTMLElement>('[data-testid="form-error"]').textContent).toContain("أدخل كمية مخزون أكبر من صفر");
    expect(createInputs.length).toBe(0);
    expect(createWithStockInputs.length).toBe(0);
  });

  it("refuses 0 with the required message, keeps the unreadable message distinct, then creates on a positive value", async () => {
    await openStockSeedForm("UNKNOWN-STOCK-2");

    setInput("item-name", "ممسوح بكمية");
    setInput("item-cost", "100");
    setInput("item-sell", "180");

    setInput("initial-stock", "0");
    click("item-save");
    await waitFor(() => el<HTMLElement>('[data-testid="form-error"]').textContent?.includes("أدخل كمية مخزون أكبر من صفر") === true);
    expect(createInputs.length).toBe(0);
    expect(createWithStockInputs.length).toBe(0);

    // a value that cannot be read keeps its own refusal
    setInput("initial-stock", "-3");
    click("item-save");
    await waitFor(() => el<HTMLElement>('[data-testid="form-error"]').textContent?.includes("أدخل مخزوناً افتتاحياً صحيحاً") === true);
    expect(createWithStockInputs.length).toBe(0);

    // a positive quantity is the one path that records the opening movement
    setInput("initial-stock", "6");
    click("item-save");
    await waitFor(() => createWithStockInputs.length === 1);
    expect(createWithStockInputs[0]).toMatchObject({ name: "ممسوح بكمية", stockOnHand: 6 });
    expect(createInputs.length).toBe(0);
  });

  it("drops the requirement when a later scan chooses the plain create path", async () => {
    await openStockSeedForm("UNKNOWN-STOCK-3");

    // the same form is reseeded plain: blank stock is a plain create again
    await scanUnknown("UNKNOWN-STOCK-4");
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create");
    await waitFor(() => inputByTestId("item-barcode").value === "UNKNOWN-STOCK-4");

    setInput("item-name", "مسح عادي");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "مسح عادي" });
    expect(createInputs[0]?.stockOnHand).toBeUndefined();
    expect(createWithStockInputs.length).toBe(0);
  });

  it("clears the filled scan draft with its session, so it cannot bypass the required stock", async () => {
    await openStockSeedForm("UNKNOWN-STOCK-5");

    setInput("item-name", "عودة للتبويب");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    // the seeded form refuses blank stock…
    click("item-save");
    await waitFor(() => el<HTMLElement>('[data-testid="form-error"]').textContent?.includes("أدخل كمية مخزون أكبر من صفر") === true);
    expect(createInputs.length).toBe(0);

    // …and leaving the add tab ends the whole scan session: the seed AND the
    // filled draft go together, so the scanned item cannot be saved later
    // without the opening stock the choice required
    click("items-tab-products");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === true);
    expect(inputByTestId("item-name").value).toBe("");
    expect(inputByTestId("item-barcode").value).toBe("");
    expect(inputByTestId("initial-stock").value).toBe("");
    expect(inputByTestId("initial-stock").getAttribute("aria-required")).toBeNull();

    // a return through the tab is a fresh, plain add where blank stock is an
    // explicit no-movement create
    click("items-tab-add");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);
    setInput("item-name", "عودة للتبويب");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "عودة للتبويب" });
    expect(createInputs[0]?.stockOnHand).toBeUndefined();
    expect(createWithStockInputs.length).toBe(0);
  });

  it("keeps a plain scan's filled draft across a tab switch, unlike a stocked one", async () => {
    // the plain create choice carries no required stock, so its filled draft is
    // ordinary unsaved work the tab switch must not throw away
    await mount();
    await scanUnknown("UNKNOWN-PLAIN-1");
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create");
    await waitFor(() => inputByTestId("item-barcode").value === "UNKNOWN-PLAIN-1");

    setInput("item-name", "مسح عادي بمسودة");
    setInput("item-cost", "100");
    setInput("item-sell", "180");

    click("items-tab-products");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === true);
    click("items-tab-add");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);

    // the draft survived, and the plain form carries no required-stock signal
    expect(inputByTestId("item-name").value).toBe("مسح عادي بمسودة");
    expect(inputByTestId("item-barcode").value).toBe("UNKNOWN-PLAIN-1");
    expect(inputByTestId("initial-stock").getAttribute("aria-required")).toBeNull();

    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "مسح عادي بمسودة", costPrice: 100, sellingPrice: 180 });
    expect(createInputs[0]?.stockOnHand).toBeUndefined();
    expect(createWithStockInputs.length).toBe(0);
  });

  it("does not let a new scan barcode inherit the previous plain draft's details", async () => {
    // barcode A: a plain draft that survives an ordinary tab switch
    await mount();
    await scanUnknown("UNKNOWN-A-1");
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create");
    await waitFor(() => inputByTestId("item-barcode").value === "UNKNOWN-A-1");
    setInput("item-name", "منتج أ");
    setInput("item-cost", "100");
    setInput("item-sell", "180");

    click("items-tab-products");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === true);
    click("items-tab-add");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === false);
    expect(inputByTestId("item-name").value).toBe("منتج أ");

    // barcode B: the new seed starts clean instead of reusing A's details
    await scanUnknown("UNKNOWN-B-2");
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create");
    await waitFor(() => inputByTestId("item-barcode").value === "UNKNOWN-B-2");
    expect(inputByTestId("item-name").value).toBe("");
    expect(inputByTestId("item-cost").value).toBe("");
    expect(inputByTestId("item-sell").value).toBe("");
    expect(inputByTestId("initial-stock").value).toBe("");

    // the save carries B with the details typed after the scan
    setInput("item-name", "منتج ب");
    setInput("item-cost", "200");
    setInput("item-sell", "260");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "منتج ب", costPrice: 200, sellingPrice: 260 });
    expect(createWithStockInputs.length).toBe(0);
  });

  it("ignores a stale save so a new scan keeps its required stock and no old error", async () => {
    createWithStockDeferred = true;
    await openStockSeedForm("UNKNOWN-STOCK-6");

    setInput("item-name", "منتج قديم بمخزون");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    setInput("initial-stock", "5");
    click("item-save");
    await waitFor(() => createWithStockInputs.length === 1);

    // the save is still in flight while the operator leaves the tab (the form
    // remounts) and starts a fresh stocked scan in a new session
    click("items-tab-products");
    await waitFor(() => el<HTMLElement>("#items-panel-add").hidden === true);
    await scanUnknown("UNKNOWN-STOCK-7");
    await waitFor(() => document.querySelector('[data-testid="unknown-scan-dialog"]') !== null);
    click("scan-create-stock");
    await waitFor(() => inputByTestId("item-barcode").value === "UNKNOWN-STOCK-7");
    expect(inputByTestId("initial-stock").getAttribute("aria-required")).toBe("true");

    // the OLD save settles late: it must not clear the new scan's requirement
    // or leave its result (or error) on the new draft
    await act(async () => {
      resolveCreateWithStock?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(inputByTestId("initial-stock").getAttribute("aria-required")).toBe("true");
    expect(document.querySelector('[data-testid="form-error"]')).toBeNull();

    // and the new item still refuses blank stock instead of saving silently
    setInput("item-name", "منتج جديد بمخزون");
    setInput("item-cost", "100");
    setInput("item-sell", "180");
    click("item-save");
    await waitFor(() => el<HTMLElement>('[data-testid="form-error"]').textContent?.includes("أدخل كمية مخزون أكبر من صفر") === true);
    expect(createWithStockInputs.length).toBe(1); // only the old save was sent
    expect(createInputs.length).toBe(0);
  });

  it("marks the seeded stock field required and the plain one optional", async () => {
    await openStockSeedForm("UNKNOWN-STOCK-A11Y");
    const seeded = inputByTestId("initial-stock");
    expect(seeded.getAttribute("aria-required")).toBe("true");
    // the visible hint and its screen-reader text live on the label
    expect(seeded.closest("label")?.textContent).toContain("مطلوب");
  });

  it("leaves the plain add form's stock field optional", async () => {
    await mount();
    await openAddTab();
    const plain = inputByTestId("initial-stock");
    expect(plain.getAttribute("aria-required")).toBeNull();
    expect(plain.closest("label")?.textContent).not.toContain("مطلوب");
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
      await settle();
    });
    expect(inputByTestId("stock-unit-cost").value).toBe("999");

    click("stock-save");
    await waitFor(() => stockInputs.length === 1);
    expect(stockInputs[0]).toMatchObject({ itemId: "item-1", delta: 4, unitCost: 999 });
  });

  it("rejects a non-numeric unit cost without calling the server", async () => {
    await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");
    setInput("stock-unit-cost", "12,5");
    setInput("stock-delta", "1");
    click("stock-save");
    await waitFor(() => document.querySelector('[data-testid="stock-error"]') !== null);
    expect(el<HTMLElement>('[data-testid="stock-error"]').textContent).toContain("تكلفة");
    expect(stockInputs.length).toBe(0);
  });

  it("treats a whitespace-only unit cost as blank, not zero", async () => {
    await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");
    setInput("stock-unit-cost", "   ");
    setInput("stock-delta", "5");
    click("stock-save");
    await waitFor(() => stockInputs.length === 1);
    // undefined lets the api fall back to the item's known cost; 0 would move
    // the weighted average to zero
    expect(stockInputs[0]).toMatchObject({ itemId: "item-1", delta: 5 });
    expect(stockInputs[0]?.unitCost).toBeUndefined();
  });

  it("treats a mark-only unit cost as blank, not as an invalid cost (#244)", async () => {
    await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");
    // a bidi mark is Cf, not whitespace: the raw gate called it a chosen cost
    // and then refused it, instead of falling back to the item's known cost
    setInput("stock-unit-cost", "\u200f");
    setInput("stock-delta", "5");
    click("stock-save");
    await waitFor(() => stockInputs.length === 1);
    expect(stockInputs[0]).toMatchObject({ itemId: "item-1", delta: 5 });
    expect(stockInputs[0]?.unitCost).toBeUndefined();
    expect(document.querySelector('[data-testid="stock-error"]')).toBeNull();
  });

  it("does not prefill the pre-movement cost while the refetch is in flight", async () => {
    await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");

    // hold the refetch open: the invalidation cannot deliver fresh data yet
    itemsGate = new Promise<void>((resolve) => {
      releaseItemsGate = resolve;
    });
    setInput("stock-delta", "5");
    click("stock-save");
    await waitFor(() => stockInputs.length === 1);

    // the cached average predates this movement, so the field must stay blank
    // instead of offering a cost that would corrupt the running average
    await flush();
    expect(inputByTestId("stock-unit-cost").value).toBe("");

    firstFixtureItem().costPrice = 250;
    await act(async () => {
      releaseItemsGate?.();
      await settle();
    });
    await waitFor(() => inputByTestId("stock-unit-cost").value === "250");
  });

  it("disables the unit cost for a removal instead of discarding it", async () => {
    await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");

    setInput("stock-delta", "-5");
    // a removal cannot carry a cost; leaving the field editable promises a
    // recording the api never receives
    await waitFor(() => inputByTestId("stock-unit-cost").disabled === true);

    setInput("stock-delta", "5");
    await waitFor(() => inputByTestId("stock-unit-cost").disabled === false);
  });

  it("names the quantity problem instead of repeating the field label", async () => {
    await mount();
    await openAddTab();
    setInput("stock-delta", "0");
    click("stock-save");
    await waitFor(() => document.querySelector('[data-testid="stock-error"]') !== null);
    const message = el<HTMLElement>('[data-testid="stock-error"]').textContent ?? "";
    expect(message).not.toBe("");
    // the label already says this; an error has to say what is wrong
    expect(message).not.toContain("موجب إدخال");
    expect(stockInputs.length).toBe(0);
  });

  it("refreshes a prefilled cost when the item's known cost changes, without clobbering a typed value", async () => {
    const { queryClient } = await mount();
    await openAddTab();
    await waitFor(() => inputByTestId("stock-unit-cost").value === "100");

    // untouched field: a corrected cost elsewhere refreshes the prefill
    firstFixtureItem().costPrice = 150;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["itemsAll"] });
      await settle();
    });
    await waitFor(() => inputByTestId("stock-unit-cost").value === "150");

    // typed field: a later refetch must not overwrite the operator's value
    setInput("stock-unit-cost", "999");
    firstFixtureItem().costPrice = 175;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["itemsAll"] });
      await settle();
    });
    expect(inputByTestId("stock-unit-cost").value).toBe("999");
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

  it("keeps a zero-price item editable (sale quick-add creates selling 0)", async () => {
    firstFixtureItem().sellingPrice = 0;
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    // a name-only correction must save without the operator touching the price,
    // and without writing the price back
    setInput("edit-name", "بطارية مجانية");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    expect(updateInputs[0]).toEqual({ id: "item-1", name: "بطارية مجانية" });
  });

  it("sends only the changed field, so a value corrected elsewhere survives", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);

    // the cost was corrected after this draft was built: a whole-row write
    // would put the stale value back
    firstFixtureItem().costPrice = 175;
    setInput("edit-sell", "180");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    expect(updateInputs[0]).toEqual({ id: "item-1", sellingPrice: 180 });
    expect(firstFixtureItem().costPrice).toBe(175);
  });

  it("closes the row without a round trip when nothing changed", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') === null);
    expect(updateInputs.length).toBe(0);
    // closing with no feedback reads as a failed save to a first-week operator
    await waitFor(() => document.querySelector('[data-testid="items-edit-unchanged"]') !== null);
  });

  it("rejects a blank cost instead of silently zeroing it", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-cost"]') !== null);
    setInput("edit-cost", "");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(updateInputs.length).toBe(0);
  });

  it("keeps the server threshold when the field is blanked", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-threshold"]') !== null);
    setInput("edit-name", "بطارية بلا تنبيه");
    setInput("edit-threshold", "");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    // blank means "leave it alone", not "warn at zero"
    expect(updateInputs[0]).toEqual({ id: "item-1", name: "بطارية بلا تنبيه" });
  });

  it("treats a mark-only threshold as blank: leave the server value alone (#244)", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-threshold"]') !== null);
    setInput("edit-name", "بطارية حد ممحو");
    setInput("edit-threshold", "\u200f");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    // no threshold in the patch and no edit error: mark-only is blank, not invalid
    expect(updateInputs[0]).toEqual({ id: "item-1", name: "بطارية حد ممحو" });
    expect(document.querySelector('[data-testid="items-edit-error"]')).toBeNull();
  });

  it("rejects money written in exponent or hex notation", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-cost"]') !== null);
    setInput("edit-cost", "1e3");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(updateInputs.length).toBe(0);

    setInput("edit-cost", "0x10");
    click("edit-save");
    await flush();
    expect(updateInputs.length).toBe(0);
  });

  it("does not replace a draft the operator is still typing in", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "قيد الكتابة");

    // the other row's edit control is unavailable while this draft is dirty, so
    // typed work cannot be discarded by a stray click
    expect(el<HTMLButtonElement>('[data-testid="edit-item-item-2"]').disabled).toBe(true);

    click("edit-cancel");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') === null);
    expect(el<HTMLButtonElement>('[data-testid="edit-item-item-2"]').disabled).toBe(false);
  });

  it("follows a row whose price moved under an open draft", async () => {
    const { queryClient } = await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-cost"]') !== null);

    // the cost was corrected elsewhere while this draft sat open: the field and
    // the diff baseline must follow, or the operator edits against a value the
    // row no longer shows
    firstFixtureItem().costPrice = 175;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["items"] });
      await settle();
    });
    await waitFor(() => inputByTestId("edit-cost").value === "175");
  });

  it("invalidates the catalog search so a stale price cannot be picked", async () => {
    const { queryClient } = await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "بطارية محدثة");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);
    await waitFor(() => queryClient.getQueryState(["catalogSearch"])?.isInvalidated === true);
  });

  it("moves focus into the name field when the editor opens", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="edit-name"]'));
  });

  it("drops an open draft when a scan types into an edit field", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="edit-name"]'));

    // the wedge types its digits into the focused field; the row must not stay
    // open holding them as the item's new name
    const field = inputByTestId("edit-name");
    for (const key of ["6", "2", "1"]) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await waitFor(() => document.querySelector('[data-testid="edit-name"]') === null);
    expect(updateInputs.length).toBe(0);
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

  it("rejects a blank selling price without calling the server", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-sell"]') !== null);
    setInput("edit-sell", "   ");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(updateInputs.length).toBe(0);
  });

  it("submits an edit on Enter", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "بطارية بإدخال");
    await act(async () => {
      inputByTestId("edit-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => updateInputs.length === 1);
    expect(updateInputs[0]).toMatchObject({ id: "item-1", name: "بطارية بإدخال" });
  });

  it("rejects a non-numeric cost instead of silently zeroing it", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-cost"]') !== null);
    setInput("edit-cost", "abc");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(el<HTMLElement>('[data-testid="items-edit-error"]').textContent).toContain("تكلفة");
    expect(updateInputs.length).toBe(0);
  });

  it("rejects a negative threshold instead of silently zeroing it", async () => {
    await mount();
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-threshold"]') !== null);
    setInput("edit-threshold", "-2");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(el<HTMLElement>('[data-testid="items-edit-error"]').textContent).toContain("تنبيه");
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
    setInput("edit-name", "بطارية مرفوضة");
    click("edit-save");
    await waitFor(() => document.querySelector('[data-testid="items-edit-error"]') !== null);
    expect(document.querySelector('[data-testid="edit-name"]')).not.toBeNull();
    expect(updateInputs.length).toBe(1);
  });

  it("prevents opening another row while a save is pending", async () => {
    await mount();
    updateDeferred = true;
    click("edit-item-item-1");
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') !== null);
    setInput("edit-name", "الصف الأول");
    click("edit-save");
    await waitFor(() => updateInputs.length === 1);

    // the other row cannot be opened into a draft that row 1's completion or
    // failure would strand
    expect(el<HTMLButtonElement>('[data-testid="edit-item-item-2"]').disabled).toBe(true);

    await act(async () => {
      resolveUpdate?.();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    await waitFor(() => document.querySelector('[data-testid="edit-name"]') === null);
    expect(el<HTMLButtonElement>('[data-testid="edit-item-item-2"]').disabled).toBe(false);
  });
});

/**
 * #225 — the live profit preview reads the same cost/sell drafts the save path
 * reads. An Arabic-Indic draft must preview the figure it will save (ASCII did
 * via `Number`, Arabic used to show `…`), so the preview cannot disagree with
 * the value the form stores.
 */
describe("add item form profit preview (#225)", () => {
  it("previews and saves the same profit for an Arabic-Indic draft as for ASCII", async () => {
    await mount();
    await openAddTab();
    const preview = () => document.querySelector('[data-testid="profit-preview"]')?.textContent ?? "";

    setInput("item-cost", "100");
    setInput("item-sell", "180");
    expect(preview()).toBe(i18n.t("itemsProfitPerUnit", { profit: 80 }));

    // ١٠٠ / ۱۸۰ — the same profit, not the `…` the ASCII-only reader rendered.
    // The sell draft is Extended Arabic-Indic, so both scripts are exercised.
    setInput("item-cost", "١٠٠");
    setInput("item-sell", "۱۸۰");
    expect(preview()).toBe(i18n.t("itemsProfitPerUnit", { profit: 80 }));
    expect(preview()).not.toContain("…");

    // and the same draft saves as the numbers the preview promised
    setInput("item-name", "بطارية بأرقام");
    click("item-save");
    await waitFor(() => createInputs.length === 1);
    expect(createInputs[0]).toMatchObject({ name: "بطارية بأرقام", costPrice: 100, sellingPrice: 180 });
  });
});
