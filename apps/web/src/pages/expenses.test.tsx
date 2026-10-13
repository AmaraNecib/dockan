import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import { parseDateTimeText } from "../lib/dates";
import { activateOption, findOption, openSelect } from "../tests/select-driver";

interface ExpenseCategory {
  id: string;
  name: string;
  isOwnerWithdrawal: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CapturedExpense {
  categoryId: string;
  amount: number;
  note?: string;
  occurredAt?: string;
}

interface CategoryMutationOptions {
  onSuccess?: (category: ExpenseCategory) => void;
  onError?: (error: { message?: string }) => void;
}

interface ExpenseResponse {
  id: string;
  categoryId: string;
  amount: number;
  createdAt: string;
}

interface ExpenseMutationOptions {
  onSuccess?: (expense: ExpenseResponse) => void;
  onError?: (error: { message?: string }) => void;
}

let categoriesFixture: ExpenseCategory[] = [];
let categoryCreateFails = false;
let categoryCreateDeferred = false;
/** settle functions for deferred creates, in submit order */
let deferredCategoryCreates: Array<() => void> = [];
/** makes the category-list refetch fail after a successful create */
let categoriesListFails = false;
let lastCreatedName: string | null = null;
let lastExpense: CapturedExpense | null = null;

/** The slice of the `expensesList` input the range filters own, recorded so a
 * spec can assert the custom bounds the field parsed to. */
interface ListInput {
  preset: string;
  customFrom?: string;
  customTo?: string;
  categoryIds?: string[];
  sortBy: string;
  sortDir: string;
  pageSize: number;
  offset: number;
}

let lastListInput: ListInput | null = null;

const category = (id: string, name: string, isOwnerWithdrawal = false): ExpenseCategory => ({
  id,
  name,
  isOwnerWithdrawal,
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
});

// The page pulls its data/mutations through orpc.*; mock the rpc module so the
// rendered interaction is driven by fixtures without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    expenseCategoriesList: {
      queryOptions: () => ({
        queryKey: ["expenseCategories"],
        queryFn: async () => {
          if (categoriesListFails) throw new Error("LIST_FAILED");
          return { items: categoriesFixture };
        },
      }),
      queryKey: () => ["expenseCategories"],
    },
    expenseCategoriesCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: CategoryMutationOptions) => ({
        mutationFn: async (input: { name: string }) => {
          lastCreatedName = input.name;
          const created = category(`cat-${categoriesFixture.length + 1}`, input.name);
          const commit = () => {
            categoriesFixture = [...categoriesFixture, created];
            return created;
          };
          if (categoryCreateDeferred) {
            return new Promise<ExpenseCategory>((resolve, reject) => {
              deferredCategoryCreates.push(() => {
                if (categoryCreateFails) reject(new Error("EXPENSE_CATEGORY_EXISTS"));
                else resolve(commit());
              });
            });
          }
          if (categoryCreateFails) throw new Error("EXPENSE_CATEGORY_EXISTS");
          return commit();
        },
        ...opts,
      }),
    },
    expensesList: {
      // SAFETY: mirror the real utils signature ({ input }) and record the
      // input so a spec can assert the custom bounds the field parsed to
      queryOptions: ({ input }: { input?: ListInput }) => {
        lastListInput = input ?? null;
        return {
          queryKey: ["expenses", input],
          queryFn: async () => ({ items: [] }),
        };
      },
    },
    expensesCreate: {
      // SAFETY: pass caller options through so onSuccess/onError survive
      mutationOptions: (opts?: ExpenseMutationOptions) => ({
        mutationFn: async (input: CapturedExpense): Promise<ExpenseResponse> => {
          lastExpense = input;
          return { id: "exp-1", ...input, createdAt: "2026-01-01T00:00:00" };
        },
        ...opts,
      }),
    },
  },
  rpcClient: {},
}));

const { ExpensesPage } = await import("./expenses");

/** Sets a controlled input through the native setter + input event so React's
 * onChange fires (plain .value assignment is ignored by React's tracker). */
async function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mountPage(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ExpensesPage />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const query = <T extends Element = HTMLElement>(testid: string) =>
    container.querySelector<T>(`[data-testid="${testid}"]`);

  return {
    query,
    text: () => container.textContent ?? "",
    selectValue: () => container.querySelector('[data-slot="select-value"]')?.textContent ?? "",
    type: async (testid: string, value: string) => {
      const input = query<HTMLInputElement>(testid);
      expect(input).not.toBeNull();
      await typeInto(input!, value);
    },
    click: async (testid: string) => {
      await act(async () => {
        query(testid)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    submit: async (testid: string) => {
      await act(async () => {
        query<HTMLFormElement>(testid)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    waitFor: async (check: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return true;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      return false;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("ExpensesPage — create a category inline (issue #99)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    categoriesFixture = [];
    categoryCreateFails = false;
    categoryCreateDeferred = false;
    deferredCategoryCreates = [];
    categoriesListFails = false;
    lastCreatedName = null;
    lastExpense = null;
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("teaches the first step when no category exists and creates the first one", async () => {
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);
    const empty = ui.query("expense-category-empty")!;
    expect(empty.textContent).toContain("لا توجد تصنيفات بعد");
    expect(empty.textContent).toContain("أنشئ أول تصنيف لتسجيل مصروف");
    // no save button to fail with a technical error before a category exists
    expect(ui.query("expense-save")).toBeNull();

    await ui.click("expense-category-empty-action");
    expect(ui.query("expense-category-form")).not.toBeNull();
    await ui.type("expense-category-name", "كراء المحل");
    await ui.submit("expense-category-form");

    expect(await ui.waitFor(() => lastCreatedName === "كراء المحل")).toBe(true);
    // the new category is selected straight away and the list refetch shows it
    expect(await ui.waitFor(() => ui.selectValue().includes("كراء المحل"))).toBe(true);
    expect(ui.query("expense-category-form")).toBeNull();
    expect(ui.query("expense-save")).not.toBeNull();

    await ui.unmount();
  });

  it("adds a category from the record form and selects it immediately", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    expect(ui.query("expense-category-form")).not.toBeNull();
    await ui.type("expense-category-name", "كهرباء");
    await ui.submit("expense-category-form");

    expect(await ui.waitFor(() => lastCreatedName === "كهرباء")).toBe(true);
    expect(await ui.waitFor(() => ui.selectValue().includes("كهرباء"))).toBe(true);
    expect(ui.query("expense-category-created")?.textContent).toContain("تمت إضافة التصنيف كهرباء");

    // reopening the quick-add clears the previous success message
    await ui.click("expense-category-add");
    expect(ui.query("expense-category-created")).toBeNull();

    await ui.unmount();
  });

  it("keeps recording available when the create succeeds but the list refresh fails", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    // the refetch that follows the create will fail, so the cached list stays
    // empty even though a category now exists
    categoriesListFails = true;
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كراء المحل");
    await ui.submit("expense-category-form");
    expect(await ui.waitFor(() => lastCreatedName === "كراء المحل")).toBe(true);

    // the owner can still record against what they just created
    expect(await ui.waitFor(() => ui.query("expense-save") !== null)).toBe(true);
    expect(ui.query("expense-category-empty")).toBeNull();
    expect(ui.selectValue()).toContain("كراء المحل");

    await ui.type("expense-amount", "2000");
    await ui.click("expense-save");
    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ amount: 2000, categoryId: "cat-1" });

    await ui.unmount();
  });

  it("never offers save before any category exists, even with the create form open", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    await ui.click("expense-category-empty-action");
    expect(ui.query("expense-category-form")).not.toBeNull();
    // the dead end this state exists to prevent: a save button that can only
    // answer CATEGORY_NOT_FOUND. The fields stay, disabled, as the next step.
    expect(ui.query("expense-save")).toBeNull();
    expect(ui.query<HTMLInputElement>("expense-amount")?.disabled).toBe(true);

    await ui.unmount();
  });

  it("keeps a reopened draft when a cancelled create settles late", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    categoryCreateDeferred = true;
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كراء");
    await ui.submit("expense-category-form");

    // the owner gives up on that attempt and starts another
    await ui.click("expense-category-cancel");
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كهرباء");

    // the abandoned request lands now: it must not close the form or wipe the
    // name the owner has since typed
    await act(async () => {
      deferredCategoryCreates[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(ui.query("expense-category-form")).not.toBeNull();
    expect(ui.query<HTMLInputElement>("expense-category-name")?.value).toBe("كهرباء");
    // and it must not quietly move the selection to the abandoned category
    expect(ui.selectValue()).not.toContain("كراء");

    await ui.unmount();
  });

  it("does not let one attempt's response close another attempt's draft", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    categoryCreateDeferred = true;
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كراء");
    await ui.submit("expense-category-form");

    await ui.click("expense-category-cancel");
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كهرباء");
    await ui.submit("expense-category-form");

    // the first response arrives while the second attempt is still on screen
    await act(async () => {
      deferredCategoryCreates[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(ui.query<HTMLInputElement>("expense-category-name")?.value).toBe("كهرباء");

    // the second one belongs to this attempt, so it closes the form
    await act(async () => {
      deferredCategoryCreates[1]?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(ui.query("expense-category-form")).toBeNull();

    await ui.unmount();
  });

  it("does not paint a stale failure inside a newer draft", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    categoryCreateDeferred = true;
    categoryCreateFails = true;
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كراء");
    await ui.submit("expense-category-form");

    await ui.click("expense-category-cancel");
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كهرباء");

    await act(async () => {
      deferredCategoryCreates[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // the abandoned attempt's error belongs to the abandoned draft
    expect(ui.query("expense-category-error")).toBeNull();
    expect(ui.query<HTMLInputElement>("expense-category-name")?.value).toBe("كهرباء");

    await ui.unmount();
  });

  it("offers a retry when the category list fails instead of a dead-end save", async () => {
    categoriesListFails = true;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-categories-error") !== null)).toBe(true);
    // a save here could only answer CATEGORY_NOT_FOUND
    expect(ui.query("expense-save")).toBeNull();

    categoriesListFails = false;
    await ui.click("expense-categories-retry");
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    await ui.unmount();
  });

  it("keeps the created category filterable when the refetch fails", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    categoriesListFails = true;
    await ui.click("expense-category-empty-action");
    await ui.type("expense-category-name", "كراء المحل");
    await ui.submit("expense-category-form");

    // recordable and filterable from the same grace entry
    expect(await ui.waitFor(() => ui.query("expense-filter-cat-1") !== null)).toBe(true);

    await ui.unmount();
  });

  it("keeps the record fields visible but disabled while no category exists", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    // the fields are the next step, so they stay on screen; only save is gone
    expect(ui.query<HTMLInputElement>("expense-amount")?.disabled).toBe(true);
    expect(ui.query("expense-save")).toBeNull();

    await ui.unmount();
  });

  it("points the add control at the form it reveals", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    expect(ui.query("expense-category-add")?.getAttribute("aria-controls")).toBe("expense-category-form");
    await ui.click("expense-category-add");
    expect(ui.query("expense-category-form")?.id).toBe("expense-category-form");
    // a label must not point at a button; the trigger names itself instead
    expect(ui.query("expense-category")?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(document.querySelector('label[for="expense-category"]')).toBeNull();

    await ui.unmount();
  });

  it("does not steal the caret when the form opens mid-entry", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    const amount = ui.query<HTMLInputElement>("expense-amount");
    if (amount === null) throw new Error("no amount field");
    await act(async () => {
      amount.focus();
    });
    await ui.click("expense-category-add");
    expect(document.activeElement).toBe(amount);

    await ui.unmount();
  });

  it("marks the amount required like the category", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-amount") !== null);

    expect(ui.query("expense-amount")?.closest("label")?.textContent).toContain("*");

    await ui.unmount();
  });

  it("labels cancel as a cancel and disables it while the create is pending", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    expect(ui.query("expense-category-cancel")?.textContent).toBe(i18n.t("expenseCategoryCancel"));

    categoryCreateDeferred = true;
    await ui.type("expense-category-name", "نقل");
    await ui.submit("expense-category-form");
    // a cancel that fires while the request is in flight would orphan it
    expect(ui.query<HTMLButtonElement>("expense-category-cancel")?.disabled).toBe(true);

    await act(async () => {
      deferredCategoryCreates[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    await ui.unmount();
  });

  it("wraps the record controls in a form so Enter submits them", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-save") !== null);

    // native Enter-to-submit needs the fields inside a form with a submit
    // button; the create-category form must stay outside it (no nesting)
    expect(ui.query<HTMLInputElement>("expense-amount")?.closest("form")?.dataset.testid).toBe("expense-record-form");
    expect(ui.query<HTMLButtonElement>("expense-save")?.type).toBe("submit");
    await ui.click("expense-category-add");
    expect(ui.query("expense-category-form")?.closest("form")?.dataset.testid).toBe("expense-category-form");

    await ui.unmount();
  });

  it("records an expense against the category just created", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "نقل");
    await ui.submit("expense-category-form");
    expect(await ui.waitFor(() => lastCreatedName === "نقل")).toBe(true);

    await ui.type("expense-amount", "1500");
    await ui.click("expense-save");
    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ amount: 1500, categoryId: "cat-2" });

    await ui.unmount();
  });

  it("records a grouped amount with the shared parser (#180)", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "وقود");
    await ui.submit("expense-category-form");
    expect(await ui.waitFor(() => lastCreatedName === "وقود")).toBe(true);

    // #180 — the expense amount now uses the one shared grouped parser
    await ui.type("expense-amount", "1,000");
    await ui.click("expense-save");
    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ amount: 1000 });

    await ui.unmount();
  });

  it("names the missing category and its recovery in Arabic at submit", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-save") !== null);

    await ui.type("expense-amount", "500");
    await ui.click("expense-save");

    expect(lastExpense).toBeNull();
    expect(ui.query("expense-error")?.textContent).toContain("اختر تصنيفاً من القائمة أو أنشئ تصنيفاً جديداً");

    await ui.unmount();
  });

  it("shows the Arabic duplicate error and keeps the quick-add open", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    categoryCreateFails = true;
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "عام");
    await ui.submit("expense-category-form");

    expect(await ui.waitFor(() => ui.query("expense-category-error") !== null)).toBe(true);
    expect(ui.query("expense-category-error")?.textContent).toContain("هذا التصنيف موجود مسبقاً");
    // the form stays open so the owner can correct the name
    expect(ui.query("expense-category-form")).not.toBeNull();
    expect(ui.query("expense-category-created")).toBeNull();

    await ui.unmount();
  });

  it("rejects an empty category name in Arabic without calling the api", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.submit("expense-category-form");

    expect(lastCreatedName).toBeNull();
    expect(ui.query("expense-category-error")?.textContent).toContain("أدخل اسم التصنيف");

    await ui.unmount();
  });

  it("treats a whitespace-only name as missing without calling the api", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "   ");
    await ui.submit("expense-category-form");

    expect(lastCreatedName).toBeNull();
    expect(ui.query("expense-category-error")?.textContent).toContain("أدخل اسم التصنيف");

    await ui.unmount();
  });

  it("cancels the quick-add without creating anything", async () => {
    categoriesFixture = [category("cat-1", "عام")];
    const ui = await mountPage(queryClient);
    await ui.waitFor(() => ui.query("expense-category-add") !== null);

    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "ملغى");
    await ui.click("expense-category-cancel");

    expect(ui.query("expense-category-form")).toBeNull();
    expect(lastCreatedName).toBeNull();

    await ui.unmount();
  });
});

describe("ExpensesPage — the date/time field (issue #119)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    categoriesFixture = [category("cat-1", "عام")];
    categoryCreateFails = false;
    categoryCreateDeferred = false;
    deferredCategoryCreates = [];
    categoriesListFails = false;
    lastCreatedName = null;
    lastExpense = null;
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  /** The record form only saves with a category; the inline quick-add selects
   *  what it creates, the same path the owner uses on a fresh shop. */
  async function recordReady(ui: Awaited<ReturnType<typeof mountPage>>) {
    await ui.waitFor(() => ui.query("expense-category-add") !== null);
    await ui.click("expense-category-add");
    await ui.type("expense-category-name", "نقل");
    await ui.submit("expense-category-form");
    expect(await ui.waitFor(() => ui.query("expense-save") !== null)).toBe(true);
  }

  /** The device-local instant a `DD/MM/YYYY HH:mm` field value names. Throws
   *  when the value is not the taught shape, so a malformed value fails loudly
   *  instead of comparing NaN. */
  function fieldInstant(value: string): number {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
    if (match === null) throw new Error(`field value is not day-first: ${value}`);
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5])).getTime();
  }

  it("starts in the app's day-first shape, never a datetime-local value", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-date") !== null)).toBe(true);

    const field = ui.query<HTMLInputElement>("expense-date")!;
    expect(field.type).toBe("text");
    expect(field.value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(field.value).not.toContain("T");
    // the example is copy, not a literal in the component
    expect(field.getAttribute("placeholder")).toBe(i18n.t("expenseDateHint"));
    // shape alone would pass for 01/01/1970; the value must be the real now
    expect(Math.abs(fieldInstant(field.value) - Date.now())).toBeLessThan(90_000);

    await ui.unmount();
  });

  it("sends the typed day-first moment as the api's ISO with seconds", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "1200");
    await ui.type("expense-date", "15/01/2026 08:05");
    await ui.click("expense-save");

    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ amount: 1200, occurredAt: "2026-01-15T08:05:00" });

    await ui.unmount();
  });

  it("treats a bare date as midnight", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "1200");
    await ui.type("expense-date", "15/01/2026");
    await ui.click("expense-save");

    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ occurredAt: "2026-01-15T00:00:00" });

    await ui.unmount();
  });

  it("refuses a date it cannot read instead of sending it raw", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "1200");
    // the stored shape is not what the field teaches; a paste must be corrected
    await ui.type("expense-date", "2026-01-15T08:05");
    await ui.click("expense-save");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(lastExpense).toBeNull();
    expect(ui.query("expense-error")?.textContent).toContain("01/10/2026 00:34");
    // the form-level alert is programmatically tied to the field it names
    const field = ui.query<HTMLInputElement>("expense-date")!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("expense-error");
    // and typing a correction clears the marker
    await ui.type("expense-date", "15/01/2026 08:05");
    expect(field.getAttribute("aria-invalid")).toBeNull();

    await ui.unmount();
  });

  it("refuses an impossible calendar day instead of submitting it", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "1200");
    // 2026 is not a leap year: the api must never receive 2026-02-29
    await ui.type("expense-date", "29/02/2026");
    await ui.click("expense-save");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(lastExpense).toBeNull();
    expect(ui.query("expense-error")?.textContent).toContain("01/10/2026 00:34");

    // the real leap day is accepted and sent with its parsed ISO
    await ui.type("expense-date", "29/02/2024 08:00");
    await ui.click("expense-save");
    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);
    expect(lastExpense).toMatchObject({ occurredAt: "2024-02-29T08:00:00" });

    await ui.unmount();
  });

  it("fills the field with now from the «الآن» button", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-date", "15/01/2026 08:05");
    await ui.click("expense-date-now");

    const value = ui.query<HTMLInputElement>("expense-date")!.value;
    expect(value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(value).not.toBe("15/01/2026 08:05");
    // not just a shape: the stamp is the device's own moment
    expect(Math.abs(fieldInstant(value) - Date.now())).toBeLessThan(90_000);

    await ui.unmount();
  });

  it("clears the invalid marker and the error when «الآن» fills the date after a refusal (issue #125)", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "1200");
    await ui.type("expense-date", "2020-01-15T12:00");
    await ui.click("expense-save");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const field = ui.query<HTMLInputElement>("expense-date")!;
    expect(lastExpense).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(ui.query("expense-error")?.textContent).toContain("01/10/2026 00:34");

    // «الآن» restores a valid moment, so the stale invalid state must go with it
    await ui.click("expense-date-now");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(ui.query("expense-error")).toBeNull();

    // and the restored value records like a typed one
    await ui.click("expense-save");
    expect(await ui.waitFor(() => lastExpense !== null)).toBe(true);

    await ui.unmount();
  });

  it("keeps a non-date refusal when «الآن» fixes the timestamp (issue #125)", async () => {
    const ui = await mountPage(queryClient);
    await recordReady(ui);

    await ui.type("expense-amount", "0");
    await ui.click("expense-save");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lastExpense).toBeNull();
    expect(ui.query("expense-error")?.textContent).toContain("أدخل مبلغاً صحيحاً أكبر من صفر");

    await ui.click("expense-date-now");

    // the now button clears the date field's refusal, never the amount's
    expect(ui.query("expense-error")?.textContent).toContain("أدخل مبلغاً صحيحاً أكبر من صفر");

    await ui.unmount();
  });

  it("keeps the date field and the now button disabled with no category", async () => {
    categoriesFixture = [];
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-category-empty") !== null)).toBe(true);

    expect(ui.query<HTMLInputElement>("expense-date")?.disabled).toBe(true);
    expect(ui.query<HTMLButtonElement>("expense-date-now")?.disabled).toBe(true);

    await ui.unmount();
  });
});

describe("ExpensesPage — custom range bounds (issue #123)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    categoriesFixture = [category("cat-1", "عام")];
    lastListInput = null;
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  async function openCustomRange(ui: Awaited<ReturnType<typeof mountPage>>) {
    expect(await ui.waitFor(() => ui.query("expense-range-preset") !== null)).toBe(true);
    await openSelect(ui.query("expense-range-preset")!);
    const option = await findOption("فترة مخصصة");
    expect(option).not.toBeNull();
    await activateOption(option!);
    expect(await ui.waitFor(() => ui.query("expense-custom-from") !== null)).toBe(true);
  }

  it("shows day-first text bounds, never the OS datetime-local control", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    const from = ui.query<HTMLInputElement>("expense-custom-from")!;
    const to = ui.query<HTMLInputElement>("expense-custom-to")!;
    expect(from.type).toBe("text");
    expect(to.type).toBe("text");
    expect(from.getAttribute("placeholder")).toBe(i18n.t("expenseDateHint"));
    expect(ui.query("expense-custom-from-now")?.textContent).toContain("الآن");

    await ui.unmount();
  });

  it("sends the typed day-first bounds as the api's ISO moments, empty as open", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    // nothing typed yet: both bounds stay open
    expect(lastListInput).not.toBeNull();
    expect(lastListInput?.customFrom).toBeUndefined();
    expect(lastListInput?.customTo).toBeUndefined();

    await ui.type("expense-custom-from", "01/01/2020 00:00");
    await ui.type("expense-custom-to", "31/01/2020 23:59");

    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);
    expect(lastListInput).toMatchObject({ customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:00" });

    await ui.unmount();
  });

  it("refuses an impossible bound visibly and keeps the last applied window", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-from", "01/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);

    const from = ui.query<HTMLInputElement>("expense-custom-from")!;
    await ui.type("expense-custom-from", "31/02/2020 00:00");
    // the #119 follow-up already refuses the calendar-impossible day at the parse
    expect(parseDateTimeText("31/02/2020 00:00")).toBeNull();

    await act(async () => {
      from.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(from.getAttribute("aria-invalid")).toBe("true");
    const error = ui.query("expense-custom-from-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain(i18n.t("expenseDateInvalid"));
    // the unreadable value is not applied: the window keeps its last bound
    // instead of silently widening to everything
    expect(lastListInput?.customFrom).toBe("2020-01-01T00:00:00");

    // correcting the value clears the refusal and applies the new bound
    await ui.type("expense-custom-from", "02/01/2020 00:00");
    expect(from.getAttribute("aria-invalid")).toBeNull();
    expect(ui.query("expense-custom-from-error")).toBeNull();
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-02T00:00:00")).toBe(true);

    await ui.unmount();
  });

  it("keeps the applied bound while a new value is only half-typed", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-from", "01/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);

    // an incomplete time must not drop the bound and refetch the whole list
    await ui.type("expense-custom-from", "01/01/2020 0");
    expect(lastListInput?.customFrom).toBe("2020-01-01T00:00:00");

    await ui.unmount();
  });

  it("fills a bound with now from «الآن» and sends it", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-to", "15/01/2026 08:05");
    await ui.click("expense-custom-to-now");

    const value = ui.query<HTMLInputElement>("expense-custom-to")!.value;
    expect(value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(value).not.toBe("15/01/2026 08:05");
    expect(await ui.waitFor(() => lastListInput?.customTo === parseDateTimeText(value))).toBe(true);

    await ui.unmount();
  });
});
