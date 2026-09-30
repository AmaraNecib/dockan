import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

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
      queryOptions: () => ({
        queryKey: ["expenses"],
        queryFn: async () => ({ items: [] }),
      }),
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
