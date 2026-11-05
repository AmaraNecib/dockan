import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import { parseDateTimeText } from "../lib/dates";
import { SessionCacheScopeProvider } from "../lib/session-query-scope";
import { expenseCorrectionRecoveryQueryKey } from "../lib/query-keys";
import { activateOption, findOption, openSelect } from "../tests/select-driver";
import { focusedTestId } from "../tests/page-harness";

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

/** One row of the history list envelope the page paginates. */
interface ExpenseRow extends ExpenseResponse {
  note: string | null;
  occurredAt: string;
  effectiveAmount?: number;
  correctionCount?: number;
}

interface ExpenseMutationOptions {
  onSuccess?: (expense: ExpenseResponse) => void;
  onError?: (error: { message?: string }) => void;
}

interface CorrectionInput {
  expenseId: string;
  amount: number;
  reason?: string;
  idempotencyKey: string;
}

interface UndoInput {
  correctionId: string;
  idempotencyKey: string;
}

interface ExpenseCorrection {
  id: string;
  expenseId: string;
  effectiveAt: string;
  recordedAt: string;
  beforeAmount: number;
  afterAmount: number;
  difference: number;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  reversesCorrectionId: string | null;
}

interface ExpenseCorrectionHistoryEntry extends ExpenseCorrection {
  reversedByCorrectionId: string | null;
}

interface ExpenseCorrectionHistory {
  original: ExpenseResponse & {
    note: string | null;
    occurredAt: string;
    actorId: string | null;
    actorName: string | null;
  };
  effectiveAmount: number;
  corrections: ExpenseCorrectionHistoryEntry[];
}

interface CorrectionMutationOptions {
  onSuccess?: (correction: ExpenseCorrection) => void;
  onError?: (error: { message?: string }) => void;
}

interface UndoMutationOptions {
  onSuccess?: (correction: ExpenseCorrection) => void;
  onError?: (error: { message?: string }) => void;
}

let correctionHistories = new Map<string, ExpenseCorrectionHistory>();
let correctionInputs: CorrectionInput[] = [];
let undoInputs: UndoInput[] = [];
let correctionFailuresRemaining = 0;
let correctionFailureMessage = "EXPENSE_CORRECTION_NO_CHANGE";
let loseCorrectionResponse = false;
let deferCorrectionResponses = false;
let deferredCorrectionResponses: Array<() => void> = [];
let correctionResults = new Map<string, ExpenseCorrection>();
let loseUndoResponse = false;
let deferUndoResponses = false;
let deferredUndoResponses: Array<(loseResponse?: boolean) => void> = [];
let undoResults = new Map<string, ExpenseCorrection>();

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
  limit: number;
  offset: number;
}

let lastListInput: ListInput | null = null;
/** the history envelope the list query resolves: enough rows to page through */
let listItems: ExpenseRow[] = [];
let listTotal = 0;
/** makes the history read reject, so the error branch is distinguishable from empty */
let listFails = false;
let historyFails = false;
let historyResponseOverride: ExpenseCorrectionHistory | null = null;
let paginateByAmount = false;
let failedListReads = 0;
let lastReturnedIds: string[] = [];
/** when set, a filtered read is empty while the default window still returns
 * `listItems`: the "filtered empty, but the default month has rows" case that
 * clearing must hand focus out of (issue #96 round 4) */
let filteredEmpty = false;

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
  rpcClient: {},
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
          queryFn: async () => {
            if (listFails) {
              failedListReads += 1;
              throw new Error("LIST_FAILED");
            }
            if (paginateByAmount && input?.sortBy === "amount") {
              const sorted = [...listItems].sort((a, b) => (a.effectiveAmount! - b.effectiveAmount!) * (input.sortDir === "asc" ? 1 : -1));
              const items = sorted.slice(input.offset, input.offset + input.limit);
              lastReturnedIds = items.map((row) => row.id);
              return { items, total: listTotal };
            }
            const filtering =
              (input?.categoryIds?.length ?? 0) > 0 ||
              (input?.preset !== undefined && input.preset !== "CURRENT_MONTH");
            if (filteredEmpty && filtering) return { items: [], total: 0 };
            return { items: listItems, total: listTotal };
          },
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
    expenseCorrectionHistory: {
      queryOptions: ({ input }: { input: { expenseId: string } }) => ({
        queryKey: ["expenseCorrectionHistory", input.expenseId],
        queryFn: async (): Promise<ExpenseCorrectionHistory> => {
          if (historyFails) throw new Error("HISTORY_FAILED");
          if (historyResponseOverride !== null) return historyResponseOverride;
          const stored = correctionHistories.get(input.expenseId);
          if (stored !== undefined) return stored;
          const row = listItems.find((entry) => entry.id === input.expenseId);
          if (row === undefined) throw new Error("EXPENSE_NOT_FOUND");
          const created: ExpenseCorrectionHistory = {
            original: {
              id: row.id,
              categoryId: row.categoryId,
              amount: row.amount,
              note: row.note,
              occurredAt: row.occurredAt,
              createdAt: row.createdAt,
              actorId: null,
              actorName: null,
            },
            effectiveAmount: row.effectiveAmount ?? row.amount,
            corrections: [],
          };
          correctionHistories.set(input.expenseId, created);
          return created;
        },
      }),
    },
    expensesCorrect: {
      mutationOptions: (opts?: CorrectionMutationOptions) => ({
        mutationFn: async (input: CorrectionInput): Promise<ExpenseCorrection> => {
          correctionInputs.push(input);
          if (correctionFailuresRemaining > 0) {
            correctionFailuresRemaining -= 1;
            throw new Error(correctionFailureMessage);
          }
          const duplicate = correctionResults.get(input.idempotencyKey);
          if (duplicate !== undefined) return duplicate;
          const history = correctionHistories.get(input.expenseId);
          if (history === undefined) throw new Error("EXPENSE_NOT_FOUND");
          const correction: ExpenseCorrection = {
            id: `correction-${history.corrections.length + 1}`,
            expenseId: input.expenseId,
            effectiveAt: history.original.occurredAt,
            recordedAt: "2026-10-28T13:34:56",
            beforeAmount: history.effectiveAmount,
            afterAmount: input.amount,
            difference: input.amount - history.effectiveAmount,
            actorId: "actor-1",
            actorName: "مالك المتجر",
            reason: input.reason ?? null,
            reversesCorrectionId: null,
          };
          correctionHistories.set(input.expenseId, {
            ...history,
            effectiveAmount: input.amount,
            corrections: [...history.corrections, { ...correction, reversedByCorrectionId: null }],
          });
          listItems = listItems.map((row) => row.id === input.expenseId ? { ...row, effectiveAmount: input.amount, correctionCount: (row.correctionCount ?? 0) + 1 } : row);
          correctionResults.set(input.idempotencyKey, correction);
          if (deferCorrectionResponses) {
            return await new Promise<ExpenseCorrection>((resolve) => {
              deferredCorrectionResponses.push(() => resolve(correction));
            });
          }
          if (loseCorrectionResponse) {
            loseCorrectionResponse = false;
            throw new Error("response lost after commit");
          }
          return correction;
        },
        ...opts,
      }),
    },
    expensesCorrectionUndo: {
      mutationOptions: (opts?: UndoMutationOptions) => ({
        mutationFn: async (input: UndoInput): Promise<ExpenseCorrection> => {
          undoInputs.push(input);
          if (correctionFailuresRemaining > 0) {
            correctionFailuresRemaining -= 1;
            throw new Error(correctionFailureMessage);
          }
          const duplicate = undoResults.get(input.idempotencyKey);
          if (duplicate !== undefined) return duplicate;
          const history = [...correctionHistories.values()].find((entry) => entry.corrections.some((row) => row.id === input.correctionId));
          const target = history?.corrections.find((row) => row.id === input.correctionId);
          if (history === undefined || target === undefined) throw new Error("EXPENSE_CORRECTION_NOT_FOUND");
          const correction: ExpenseCorrection = {
            id: `correction-${history.corrections.length + 1}`,
            expenseId: target.expenseId,
            effectiveAt: history.original.occurredAt,
            recordedAt: "2026-10-28T13:34:56",
            beforeAmount: history.effectiveAmount,
            afterAmount: history.effectiveAmount - target.difference,
            difference: -target.difference,
            actorId: "actor-1",
            actorName: "مالك المتجر",
            reason: null,
            reversesCorrectionId: target.id,
          };
          correctionHistories.set(target.expenseId, {
            ...history,
            effectiveAmount: correction.afterAmount,
            corrections: history.corrections.map((row) => row.id === target.id ? { ...row, reversedByCorrectionId: correction.id } : row).concat({ ...correction, reversedByCorrectionId: null }),
          });
          listItems = listItems.map((row) => row.id === target.expenseId ? { ...row, effectiveAmount: correction.afterAmount, correctionCount: (row.correctionCount ?? 0) + 1 } : row);
          undoResults.set(input.idempotencyKey, correction);
          if (deferUndoResponses) {
            return await new Promise<ExpenseCorrection>((resolve, reject) => {
              deferredUndoResponses.push((loseResponse = false) => {
                if (loseResponse) reject(new Error("response lost after commit"));
                else resolve(correction);
              });
            });
          }
          if (loseUndoResponse) {
            loseUndoResponse = false;
            throw new Error("response lost after commit");
          }
          return correction;
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
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mountPage(queryClient: QueryClient, scopeId = "test-session") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SessionCacheScopeProvider scopeId={scopeId}>
          <ExpensesPage />
        </SessionCacheScopeProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const query = <T extends Element = HTMLElement>(testid: string) =>
    container.querySelector<T>(`[data-testid="${testid}"]`);
  const queryAll = <T extends Element = HTMLElement>(testid: string) =>
    container.querySelectorAll<T>(`[data-testid="${testid}"]`);

  return {
    query,
    queryAll,
    text: () => container.textContent ?? "",
    selectValue: () => container.querySelector('[data-slot="select-value"]')?.textContent ?? "",
    type: async (testid: string, value: string) => {
      const input = query<HTMLInputElement | HTMLTextAreaElement>(testid);
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
    /** Leave a field: React routes onBlur through the bubbling focusout event. */
    blur: async (testid: string) => {
      const input = query<HTMLInputElement>(testid);
      expect(input).not.toBeNull();
      await act(async () => {
        input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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

beforeEach(() => {
  listItems = [];
  listTotal = 0;
  filteredEmpty = false;
});

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

    await ui.blur("expense-custom-from");

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

  it("refuses an impossible upper bound the same way", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-to", "31/01/2020 23:59");
    expect(await ui.waitFor(() => lastListInput?.customTo === "2020-01-31T23:59:00")).toBe(true);

    const to = ui.query<HTMLInputElement>("expense-custom-to")!;
    await ui.type("expense-custom-to", "31/02/2020 00:00");
    await ui.blur("expense-custom-to");

    expect(to.getAttribute("aria-invalid")).toBe("true");
    expect(ui.query("expense-custom-to-error")?.getAttribute("role")).toBe("alert");
    // the upper bound keeps its last applied moment too
    expect(lastListInput?.customTo).toBe("2020-01-31T23:59:00");

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

  it("keeps a later history page when a refused bound edit is not applied", async () => {
    // enough rows that the pager offers more than one page at any page size
    listTotal = 1000;
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    // apply a real window, then move off the first page
    await ui.type("expense-custom-from", "01/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);
    await ui.click("expenses-pager-next");
    expect(await ui.waitFor(() => (lastListInput?.offset ?? 0) > 0)).toBe(true);
    const laterOffset = lastListInput!.offset;

    // a refused edit keeps the applied bound, so the offset must not jump to 0
    const from = ui.query<HTMLInputElement>("expense-custom-from")!;
    await ui.type("expense-custom-from", "31/02/2020 00:00");
    await ui.blur("expense-custom-from");

    expect(from.getAttribute("aria-invalid")).toBe("true");
    expect(ui.query("expense-custom-from-error")?.getAttribute("role")).toBe("alert");
    expect(lastListInput?.customFrom).toBe("2020-01-01T00:00:00");
    expect(lastListInput?.offset).toBe(laterOffset);

    // a real bound change is still a filter change: it must reset to page one
    await ui.type("expense-custom-from", "02/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-02T00:00:00")).toBe(true);
    expect(lastListInput?.offset).toBe(0);

    await ui.unmount();
  });

  it("keeps the refusal visible when the preset is switched away and back", async () => {
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-from", "01/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);

    const from = ui.query<HTMLInputElement>("expense-custom-from")!;
    await ui.type("expense-custom-from", "31/02/2020 00:00");
    await ui.blur("expense-custom-from");
    expect(from.getAttribute("aria-invalid")).toBe("true");
    expect(ui.query("expense-custom-from-error")?.getAttribute("role")).toBe("alert");

    // leave CUSTOM: the field unmounts, but the page keeps the text and bound
    await openSelect(ui.query("expense-range-preset")!);
    const otherPreset = await findOption(i18n.t("rangePreset_CURRENT_MONTH"));
    expect(otherPreset).not.toBeNull();
    await activateOption(otherPreset!);
    expect(await ui.waitFor(() => ui.query("expense-custom-from") === null)).toBe(true);

    // back to CUSTOM: the same unreadable value must still refuse itself
    await openSelect(ui.query("expense-range-preset")!);
    const customPreset = await findOption(i18n.t("rangePreset_CUSTOM"));
    expect(customPreset).not.toBeNull();
    await activateOption(customPreset!);
    expect(await ui.waitFor(() => ui.query("expense-custom-from") !== null)).toBe(true);

    const remounted = ui.query<HTMLInputElement>("expense-custom-from")!;
    expect(remounted.value).toBe("31/02/2020 00:00");
    expect(remounted.getAttribute("aria-invalid")).toBe("true");
    expect(ui.query("expense-custom-from-error")?.getAttribute("role")).toBe("alert");
    // the window never moved: the refusal is not a silent widening
    expect(lastListInput?.customFrom).toBe("2020-01-01T00:00:00");

    await ui.unmount();
  });

  it("keeps a later history page when a refused upper-bound edit is not applied", async () => {
    listTotal = 1000;
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    await ui.type("expense-custom-to", "31/12/2020 23:59");
    expect(await ui.waitFor(() => lastListInput?.customTo === "2020-12-31T23:59:00")).toBe(true);
    await ui.click("expenses-pager-next");
    expect(await ui.waitFor(() => (lastListInput?.offset ?? 0) > 0)).toBe(true);
    const laterOffset = lastListInput!.offset;

    const to = ui.query<HTMLInputElement>("expense-custom-to")!;
    await ui.type("expense-custom-to", "31/02/2020 00:00");
    await ui.blur("expense-custom-to");

    expect(to.getAttribute("aria-invalid")).toBe("true");
    expect(lastListInput?.customTo).toBe("2020-12-31T23:59:00");
    expect(lastListInput?.offset).toBe(laterOffset);

    await ui.unmount();
  });

  it("resets to page one only when clearing a bound that was applied", async () => {
    listTotal = 1000;
    const ui = await mountPage(queryClient);
    await openCustomRange(ui);

    // nothing applied yet: clearing the already-open bound is not a filter change
    await ui.click("expenses-pager-next");
    expect(await ui.waitFor(() => (lastListInput?.offset ?? 0) > 0)).toBe(true);
    const openOffset = lastListInput!.offset;
    await ui.type("expense-custom-from", "");
    expect(lastListInput?.offset).toBe(openOffset);

    // apply a bound, move off page one, then clear: the applied moment moved
    await ui.type("expense-custom-from", "01/01/2020 00:00");
    expect(await ui.waitFor(() => lastListInput?.customFrom === "2020-01-01T00:00:00")).toBe(true);
    await ui.click("expenses-pager-next");
    expect(await ui.waitFor(() => (lastListInput?.offset ?? 0) > 0)).toBe(true);
    await ui.type("expense-custom-from", "");
    expect(await ui.waitFor(() => lastListInput?.customFrom === undefined)).toBe(true);
    expect(lastListInput?.offset).toBe(0);

    await ui.unmount();
  });

  it("does not reset a later page when a filter is re-applied unchanged", async () => {
    listTotal = 1000;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-range-preset") !== null)).toBe(true);
    expect(await ui.waitFor(() => ui.query("expenses-pager-next") !== null)).toBe(true);

    await ui.click("expenses-pager-next");
    expect(await ui.waitFor(() => (lastListInput?.offset ?? 0) > 0)).toBe(true);
    const laterOffset = lastListInput!.offset;

    // the already-active "all categories" pill is a plain button: re-clicking it
    // changes no filter, so it must not throw the list back to page one
    await ui.click("expense-filter-all");
    expect(lastListInput?.offset).toBe(laterOffset);

    // Base UI fires onValueChange when the selected option is re-picked; the
    // guard must ignore it because the query input is unchanged
    await openSelect(ui.query("expense-range-preset")!);
    const samePreset = await findOption(i18n.t("rangePreset_CURRENT_MONTH"));
    expect(samePreset).not.toBeNull();
    await activateOption(samePreset!);
    expect(lastListInput?.offset).toBe(laterOffset);

    await openSelect(ui.query("expense-sort-by")!);
    const sameSortBy = await findOption(i18n.t("expensesSortByDate"));
    expect(sameSortBy).not.toBeNull();
    await activateOption(sameSortBy!);
    expect(lastListInput?.offset).toBe(laterOffset);

    await openSelect(ui.query("expense-sort-dir")!);
    const sameSortDir = await findOption(i18n.t("expensesSortDesc"));
    expect(sameSortDir).not.toBeNull();
    await activateOption(sameSortDir!);
    expect(lastListInput?.offset).toBe(laterOffset);

    await ui.unmount();
  });
});

describe("ExpensesPage — history empty state (issue #96)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // a category exists, so the record form is usable and the action is real
    categoriesFixture = [category("cat-1", "كراء المحل")];
    categoryCreateFails = false;
    categoryCreateDeferred = false;
    deferredCategoryCreates = [];
    categoriesListFails = false;
    lastCreatedName = null;
    lastExpense = null;
    listItems = [];
    listTotal = 0;
    listFails = false;
    filteredEmpty = false;
    lastListInput = null;
  });

  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("names the next step and focuses the adjacent record field", async () => {
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expenses-empty") !== null)).toBe(true);
    const empty = ui.query("expenses-empty")!;
    expect(empty.textContent).toContain(i18n.t("expensesEmpty"));
    expect(empty.textContent).toContain(i18n.t("expensesEmptyHint"));

    const action = ui.query<HTMLButtonElement>("expenses-empty-action");
    expect(action).not.toBeNull();
    expect(action!.textContent).toBe(i18n.t("expensesEmptyAction"));

    // the action moves the caret to the amount field that records the expense
    await ui.click("expenses-empty-action");
    expect(document.activeElement).toBe(ui.query("expense-amount"));

    await ui.unmount();
  });

  it("does not show the history empty state when a row exists", async () => {
    listItems = [{ id: "exp-1", categoryId: "cat-1", amount: 500, note: null, occurredAt: "2026-01-01T00:00:00", createdAt: "2026-01-01T00:00:00" }];
    listTotal = 1;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(ui.query("expenses-empty")).toBeNull();

    await ui.unmount();
  });

  it("offers to clear the filter when a period or category filter is active", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expenses-empty") !== null)).toBe(true);

    // a category filter means a new expense may not land in this view, so the
    // honest action is to clear the filter, not to focus the form
    await ui.click("expense-filter-cat-1");
    expect(await ui.waitFor(() => ui.query("expenses-empty")?.textContent?.includes(i18n.t("expensesEmptyFilteredHint")) === true)).toBe(true);
    expect(ui.query("expenses-empty-action")?.textContent).toBe(i18n.t("expensesEmptyClearFilters"));

    await ui.click("expenses-empty-action");
    expect(await ui.waitFor(() => ui.query("expenses-empty")?.textContent?.includes(i18n.t("expensesEmptyHint")) === true)).toBe(true);

    await ui.unmount();
  });

  it("keeps focus on the category that emptied the filtered view when clearing", async () => {
    // the default month has a row; selecting a second category the read does not
    // contain empties the filtered view, and the default month still has rows --
    // so clearing replaces the empty state itself (issue #96 round 4)
    categoriesFixture = [category("cat-1", "كراء المحل"), category("cat-2", "كهرباء")];
    listItems = [
      {
        id: "exp-1",
        categoryId: "cat-1",
        amount: 500,
        note: null,
        occurredAt: "2026-01-01T00:00:00",
        createdAt: "2026-01-01T00:00:00",
      },
    ];
    listTotal = 1;
    filteredEmpty = true;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(ui.query("expenses-empty")).toBeNull();

    // the pills arrive with the category read, which can settle after the rows
    expect(await ui.waitFor(() => ui.query("expense-filter-cat-2") !== null)).toBe(true);
    await ui.click("expense-filter-cat-2");
    expect(await ui.waitFor(() => ui.query("expenses-empty-action") !== null)).toBe(true);
    expect(ui.query("expenses-empty-action")?.textContent).toBe(i18n.t("expensesEmptyClearFilters"));

    // a keyboard user activates the button they tabbed to: focus it first, so the
    // assertion below cannot be satisfied by focus that a previous interaction
    // left lying on the right control (issue #96 round 4)
    ui.query<HTMLButtonElement>("expenses-empty-action")!.focus();
    await ui.click("expenses-empty-action");

    // the clicked button was replaced by the table, so focus must land on a
    // control that survives -- and it follows the filter that emptied the view
    // (the pill), not the range preset that never narrowed it
    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(focusedTestId()).toBe("expense-filter-cat-2");

    await ui.unmount();
  });

  it("falls back to the range preset when the window emptied the view", async () => {
    // no category is selected, so the window is what emptied the view: focus
    // must come back to the range control that changed it
    listItems = [
      {
        id: "exp-1",
        categoryId: "cat-1",
        amount: 500,
        note: null,
        occurredAt: "2026-01-01T00:00:00",
        createdAt: "2026-01-01T00:00:00",
      },
    ];
    listTotal = 1;
    filteredEmpty = true;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-range-preset") !== null)).toBe(true);
    expect(ui.query("expenses-empty")).toBeNull();

    await openSelect(ui.query("expense-range-preset")!);
    const shorterWindow = await findOption(i18n.t("rangePreset_7D"));
    expect(shorterWindow).not.toBeNull();
    await activateOption(shorterWindow!);
    expect(await ui.waitFor(() => ui.query("expenses-empty-action") !== null)).toBe(true);

    // the select hands focus back to its trigger when it closes, so the button
    // must be focused explicitly or this assertion would pass on unfixed code
    // by inheriting that focus (the test would then prove nothing)
    ui.query<HTMLButtonElement>("expenses-empty-action")!.focus();
    await ui.click("expenses-empty-action");

    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(focusedTestId()).toBe("expense-range-preset");

    await ui.unmount();
  });

  it("returns focus to the all-categories pill when the owner last touched it", async () => {
    listItems = [
      {
        id: "exp-1",
        categoryId: "cat-1",
        amount: 500,
        note: null,
        occurredAt: "2026-01-01T00:00:00",
        createdAt: "2026-01-01T00:00:00",
      },
    ];
    listTotal = 1;
    filteredEmpty = true;
    const ui = await mountPage(queryClient);

    // a window with no rows: the history is empty whatever the categories are
    await openSelect(ui.query("expense-range-preset")!);
    const shorterWindow = await findOption(i18n.t("rangePreset_7D"));
    expect(shorterWindow).not.toBeNull();
    await activateOption(shorterWindow!);
    expect(await ui.waitFor(() => ui.query("expenses-empty-action") !== null)).toBe(true);

    expect(await ui.waitFor(() => ui.query("expense-filter-cat-1") !== null)).toBe(true);
    await ui.click("expense-filter-cat-1");
    await ui.click("expense-filter-all");

    // the last change was the pill, and the window is still empty, so the clear
    // button remains and focus must go back to the pill itself
    const action = ui.query<HTMLButtonElement>("expenses-empty-action");
    expect(action).not.toBeNull();
    action!.focus();
    await ui.click("expenses-empty-action");

    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(focusedTestId()).toBe("expense-filter-all");

    await ui.unmount();
  });

  it("falls back to the range preset when the recorded pill is gone", async () => {
    categoriesFixture = [category("cat-1", "كراء المحل"), category("cat-2", "كهرباء")];
    listItems = [
      {
        id: "exp-1",
        categoryId: "cat-1",
        amount: 500,
        note: null,
        occurredAt: "2026-01-01T00:00:00",
        createdAt: "2026-01-01T00:00:00",
      },
    ];
    listTotal = 1;
    filteredEmpty = true;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expense-filter-cat-2") !== null)).toBe(true);
    await ui.click("expense-filter-cat-2");
    expect(await ui.waitFor(() => ui.query("expenses-empty-action") !== null)).toBe(true);

    // the category list loses that pill while its filter is still applied, so the
    // recorded focus target is gone by the time the clear runs: focus must land on
    // the fallback instead of being dropped a second time
    categoriesFixture = [category("cat-1", "كراء المحل")];
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(await ui.waitFor(() => ui.query("expense-filter-cat-2") === null)).toBe(true);
    expect(ui.query("expenses-empty-action")).not.toBeNull();

    ui.query<HTMLButtonElement>("expenses-empty-action")!.focus();
    await ui.click("expenses-empty-action");

    expect(await ui.waitFor(() => ui.query("expense-history") !== null)).toBe(true);
    expect(focusedTestId()).toBe("expense-range-preset");

    await ui.unmount();
  });

  it("points at creating a category when the record form is unusable", async () => {
    categoriesFixture = [];
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expenses-empty") !== null)).toBe(true);

    // no category to file under: the amount field is disabled, so the empty
    // state must not offer the dead focus action; it opens the inline create
    const empty = ui.query("expenses-empty")!;
    expect(empty.textContent).toContain(i18n.t("expensesEmptyNoCategory"));
    expect(empty.textContent).toContain(i18n.t("expenseCategoryEmptyHint"));
    const action = ui.query<HTMLButtonElement>("expenses-empty-action");
    expect(action?.textContent).toBe(i18n.t("expenseCategoryCreateFirst"));

    await ui.click("expenses-empty-action");
    expect(await ui.waitFor(() => ui.query("expense-category-form") !== null)).toBe(true);

    await ui.unmount();
  });

  it("shows the error box, not the empty state, when the history read fails", async () => {
    listFails = true;
    const ui = await mountPage(queryClient);

    expect(await ui.waitFor(() => ui.query("expenses-history-error") !== null)).toBe(true);
    expect(ui.query("expenses-empty")).toBeNull();

    await ui.unmount();
  });
});

describe("ExpensesPage — immutable expense corrections (#408)", () => {
  let queryClient: QueryClient;
  let report: QueryObserver<{ operatingExpenses: number }>;
  let stopReport: () => void;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    categoriesFixture = [category("cat-1", "كراء المحل")];
    listItems = [{
      id: "exp-1",
      categoryId: "cat-1",
      amount: 1_000,
      effectiveAmount: 1_000,
      correctionCount: 0,
      note: "إيصال قديم",
      occurredAt: "2019-12-15T10:00:00",
      createdAt: "2019-12-16T11:00:00",
    }];
    listTotal = 1;
    listFails = false;
    correctionHistories = new Map();
    correctionInputs = [];
    undoInputs = [];
    correctionFailuresRemaining = 0;
    correctionFailureMessage = "EXPENSE_CORRECTION_NO_CHANGE";
    loseCorrectionResponse = false;
    deferCorrectionResponses = false;
    deferredCorrectionResponses = [];
    correctionResults = new Map();
    loseUndoResponse = false;
    deferUndoResponses = false;
    deferredUndoResponses = [];
    undoResults = new Map();
    historyFails = false;
    historyResponseOverride = null;
    paginateByAmount = false;
    failedListReads = 0;
    lastReturnedIds = [];
    // An active original-period report query uses the same server fixture as
    // the list. This proves query reconciliation, not report arithmetic.
    report = new QueryObserver<{ operatingExpenses: number }>(queryClient, {
      queryKey: ["reportsProfit", { preset: "CUSTOM", customFrom: "2019-12-01T00:00:00", customTo: "2020-01-01T00:00:00" }],
      queryFn: async () => ({ operatingExpenses: listItems[0]!.effectiveAmount! }),
      staleTime: Infinity,
    });
    stopReport = () => report.destroy();
  });

  afterEach(() => {
    stopReport();
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("shows original business date and recording time without inventing a legacy actor", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-history") !== null)).toBe(true);

    const original = ui.query("expense-correction-original")!;
    expect(original.textContent).toContain(i18n.t("expenseCorrectionOriginal"));
    expect(original.textContent).toContain("15/12/2019");
    expect(original.textContent).toContain("16/12/2019");
    expect(original.textContent).toContain(i18n.t("expenseActorUnknown"));
    expect(original.textContent).toContain("1,000");

    await ui.unmount();
  });

  it.each(["correction", "undo"])("uses the acknowledged %s amount when both reads fail", async (action) => {
    if (action === "undo") {
      const priorCorrection: ExpenseCorrectionHistoryEntry = {
        id: "correction-1",
        expenseId: "exp-1",
        effectiveAt: "2019-12-15T10:00:00",
        recordedAt: "2026-10-28T13:34:56",
        beforeAmount: 1_000,
        afterAmount: 800,
        difference: -200,
        actorId: "actor-1",
        actorName: "مالك المتجر",
        reason: "receipt typo",
        reversesCorrectionId: null,
        reversedByCorrectionId: null,
      };
      correctionHistories.set("exp-1", {
        original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
        effectiveAmount: 800,
        corrections: [priorCorrection],
      });
      listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    }
    const expectedAmount = action === "correction" ? 800 : 1_000;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);

    if (action === "correction") {
      await ui.click("expense-correction-open-editor");
      expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
      await ui.type("expense-correction-amount", String(expectedAmount));
      listFails = true;
      historyFails = true;
      await ui.submit("expense-correction-form");
      expect(await ui.waitFor(() => ui.query("expense-correction-saved") !== null && ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null)).toBe(true);
    } else {
      await ui.click("expense-correction-open-history");
      expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
      await ui.click("expense-correction-undo");
      listFails = true;
      historyFails = true;
      await ui.click("expense-correction-undo-confirm-button");
      expect(await ui.waitFor(() => ui.query("expense-correction-saved") !== null && ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null)).toBe(true);
    }

    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe(String(expectedAmount));
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);
    expect(action === "correction" ? correctionInputs : undoInputs).toHaveLength(1);

    await ui.unmount();
  });

  it("keeps an off-page acknowledgement after its notice is dismissed", async () => {
    paginateByAmount = true;
    listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, note: "other expense", effectiveAmount: 900 }))];
    listTotal = listItems.length;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await openSelect(ui.query("expense-sort-by")!);
    await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
    expect(await ui.waitFor(() => lastListInput?.sortBy === "amount" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);

    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);
    const staleHistory = queryClient.getQueryData<ExpenseCorrectionHistory>(["expenseCorrectionHistory", "exp-1"])!;
    await ui.type("expense-correction-amount", "800");
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expense-correction-error") !== null && !lastReturnedIds.includes("exp-1") && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-correction-history")).not.toBeNull();

    queryClient.setQueryData(["expenseCorrectionHistory", "exp-1"], staleHistory);
    listFails = true;
    historyFails = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expense-correction-history-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-correction-saved")).not.toBeNull();
    expect(lastReturnedIds).not.toContain("exp-1");
    const acknowledgedRow = [...ui.queryAll<HTMLElement>("expense-row-note")].find((note) => note.textContent === "إيصال قديم")?.parentElement;
    expect(acknowledgedRow?.querySelector('[data-testid="expense-row-effective-amount"]')?.getAttribute("data-value")).toBe("800");
    const dismiss = ui.query<HTMLButtonElement>("expense-correction-dismiss")!;
    expect(dismiss.getAttribute("aria-label")).toBe(i18n.t("expenseCorrectionDismiss"));
    await ui.click("expense-correction-dismiss");
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(acknowledgedRow?.querySelector('[data-testid="expense-row-effective-amount"]')?.getAttribute("data-value")).toBe("800");
    expect(acknowledgedRow?.querySelector<HTMLButtonElement>('[data-testid="expense-correction-open-editor"]')?.disabled).toBe(true);
    expect(correctionInputs).toHaveLength(2);

    await ui.unmount();
  });

  it("keeps the success notice after its acknowledged row leaves the sorted page", async () => {
    paginateByAmount = true;
    listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, note: "other expense", effectiveAmount: 900 }))];
    listTotal = listItems.length;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await openSelect(ui.query("expense-sort-by")!);
    await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
    expect(await ui.waitFor(() => lastListInput?.sortBy === "amount" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);

    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expense-correction-error") !== null && !lastReturnedIds.includes("exp-1") && queryClient.isFetching() === 0)).toBe(true);

    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expense-correction-saved") !== null && !lastReturnedIds.includes("exp-1") && queryClient.isFetching() === 0)).toBe(true);
    expect([...ui.queryAll<HTMLElement>("expense-row-note")].some((note) => note.textContent === "إيصال قديم")).toBe(false);
    expect(ui.query("expense-correction-saved")?.textContent).toBe(i18n.t("expenseCorrectionSaved"));

    await ui.click("expense-correction-dismiss");
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(correctionInputs).toHaveLength(2);
    await ui.unmount();
  });

  it("keeps an undo acknowledgement after its retried row leaves the sorted page without an editor", async () => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_200,
      afterAmount: 800,
      difference: -400,
      actorId: "actor-1",
      actorName: "مالك المتجر",
      reason: "receipt typo",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_200, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800,
      corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, amount: 1_200, effectiveAmount: 800, correctionCount: 1 };
    paginateByAmount = true;
    listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, effectiveAmount: 900 }))];
    listTotal = listItems.length;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await openSelect(ui.query("expense-sort-dir")!);
    await activateOption((await findOption(i18n.t("expensesSortAsc")))!);
    await openSelect(ui.query("expense-sort-by")!);
    await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
    expect(await ui.waitFor(() => lastListInput?.sortBy === "amount" && lastListInput.sortDir === "asc" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.click("expense-correction-undo");
    loseUndoResponse = true;
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && ui.query("expense-correction-undo-confirm") !== null && !lastReturnedIds.includes("exp-1") && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-correction-form")).toBeNull();

    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 2 && ui.query("expense-correction-history") === null && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-correction-saved")).not.toBeNull();

    await ui.unmount();
  });

  it("renders the correction difference sign inside the Amount figures isolate", async () => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: "actor-1",
      actorName: "مالك المتجر",
      reason: "receipt typo",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800,
      corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-difference") !== null)).toBe(true);
    const figures = ui.query("expense-correction-difference")?.querySelector('[data-testid="money-figures"]');
    expect(figures?.textContent).toContain("−");

    await ui.unmount();
  });

  it("re-expands history from Correct without replacing the active draft", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.type("expense-correction-reason", "keep this draft");
    await ui.click("expense-correction-open-history");
    expect(ui.query("expense-correction-history")).toBeNull();
    expect(ui.query("expense-correction-form")).toBeNull();

    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-history") !== null && ui.query("expense-correction-form") !== null)).toBe(true);
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("keep this draft");

    await ui.unmount();
  });

  it.each([
    "temporary transport failure",
    "Network error: EXPENSE_CORRECTION_NO_CHANGE",
  ])("keeps a failed draft and reuses its idempotency key on retry after %s", async (message) => {
    correctionFailuresRemaining = 1;
    correctionFailureMessage = message;
    report.subscribe(() => {});
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.type("expense-correction-reason", "receipt typo");
    await ui.submit("expense-correction-form");

    expect(await ui.waitFor(() => ui.query("expense-correction-error") !== null)).toBe(true);
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLInputElement>("expense-correction-reason")?.value).toBe("receipt typo");
    expect(correctionInputs).toHaveLength(1);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");
    expect(ui.query("expense-correction-entry")).toBeNull();
    expect(report.getCurrentResult().data?.operatingExpenses).toBe(1_000);

    const firstKey = correctionInputs[0]?.idempotencyKey;
    await ui.click("expense-correction-open-editor");
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLInputElement>("expense-correction-reason")?.value).toBe("receipt typo");
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expense-correction-error") !== null)).toBe(true);
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "800")).toBe(true);
    expect(await ui.waitFor(() => ui.query("expense-correction-entry")?.textContent?.includes("receipt typo") === true)).toBe(true);
    expect(await ui.waitFor(() => report.getCurrentResult().data?.operatingExpenses === 800)).toBe(true);
    expect(ui.query("expense-correction-error")).not.toBeNull();
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLInputElement>("expense-correction-reason")?.value).toBe("receipt typo");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") === null)).toBe(true);
    expect(correctionInputs).toHaveLength(3);
    expect(correctionInputs[2]?.idempotencyKey).toBe(firstKey);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(1);
    expect(correctionInputs[1]?.idempotencyKey).toBe(firstKey);
    expect(correctionInputs[1]?.reason).toBe("receipt typo");
    expect(ui.query("expense-correction-error")).toBeNull();
    expect(correctionHistories.get("exp-1")?.corrections[0]).toMatchObject({ beforeAmount: 1_000, afterAmount: 800, difference: -200 });

    await ui.unmount();
  });

  it.each(["list error", "page removal", "history error"])("retains exact correction recovery after %s", async (incident) => {
    queryClient.setDefaultOptions({ queries: { retry: 2, retryDelay: 0 }, mutations: { retry: false } });
    if (incident === "page removal") {
      paginateByAmount = true;
      listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, effectiveAmount: 900 }))];
      listTotal = listItems.length;
    }
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    if (incident === "page removal") {
      await openSelect(ui.query("expense-sort-by")!);
      await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
      expect(await ui.waitFor(() => lastListInput?.sortBy === "amount" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);
    }
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.type("expense-correction-reason", "exact recovery payload");
    listFails = incident === "list error";
    historyFails = incident === "history error";
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    if (incident === "list error") {
      expect(await ui.waitFor(() => ui.query("expenses-history-error") !== null)).toBe(true);
      expect(failedListReads).toBe(3);
    } else if (incident === "page removal") {
      expect(await ui.waitFor(() => !lastReturnedIds.includes("exp-1"))).toBe(true);
    } else {
      expect(await ui.waitFor(() => ui.query("expense-correction-history-error") !== null)).toBe(true);
    }
    expect(ui.query("expense-correction-form")).not.toBeNull();
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("exact recovery payload");
    expect(ui.query("expense-correction-error")).not.toBeNull();
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(correctionInputs).toHaveLength(1);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(1);
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expense-correction-form") === null)).toBe(true);
    expect(correctionInputs[1]).toEqual(correctionInputs[0]);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(1);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(800);
    await ui.unmount();
  });

  it.each(["history", "list"] as const)("keeps the newer amount when a replay arrives with stale %s data", async (staleRead) => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expense-correction-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    const firstKey = correctionInputs[0]!.idempotencyKey;

    const firstHistory = correctionHistories.get("exp-1")!;
    const laterCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-2",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:40:00",
      beforeAmount: 800,
      afterAmount: 900,
      difference: 100,
      actorId: "actor-2",
      actorName: "مالك المتجر",
      reason: "second verified amount",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      ...firstHistory,
      effectiveAmount: 900,
      corrections: [...firstHistory.corrections, laterCorrection],
    });
    if (staleRead === "history") {
      historyResponseOverride = firstHistory;
      listItems = [{ ...listItems[0]!, effectiveAmount: 900, correctionCount: 2 }];
    }
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    if (staleRead === "list") {
      await ui.click("expense-correction-open-history");
      await ui.click("expense-correction-open-history");
    }
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "900")).toBe(true);

    // The unchanged draft retries the first request with its original key.
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && queryClient.isFetching() === 0)).toBe(true);
    expect(correctionInputs[1]?.idempotencyKey).toBe(firstKey);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(900);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("900");
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).not.toBe("800");

    await ui.unmount();
  });

  it("requires a post-ack history read before a cached replay can reconcile current money", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");

    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expense-correction-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    const firstInput = correctionInputs[0]!;
    const firstHistory = correctionHistories.get("exp-1")!;
    const laterCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-2",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:40:00",
      beforeAmount: 800,
      afterAmount: 900,
      difference: 100,
      actorId: "actor-2",
      actorName: "مالك المتجر",
      reason: "other session correction",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      ...firstHistory,
      effectiveAmount: 900,
      corrections: [...firstHistory.corrections, laterCorrection],
    });
    listItems = [{ ...listItems[0]!, effectiveAmount: 900, correctionCount: 2 }];
    listFails = true;
    historyFails = true;

    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    expect(correctionInputs[1]?.idempotencyKey).toBe(firstInput.idempotencyKey);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("800");
    expect(ui.query("expense-correction-amount-unverified")).not.toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    listFails = false;
    historyFails = false;
    await ui.click("expense-correction-amount-retry");
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "900")).toBe(true);
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(false);
    expect(ui.queryAll("expense-correction-entry")).toHaveLength(2);

    await ui.unmount();
  });

  it("does not let a delayed correction acknowledgement replace an undo acknowledgement", async () => {
    deferCorrectionResponses = true;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);

    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    await ui.click("expense-correction-open-history");
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("800");

    listFails = true;
    historyFails = true;
    await ui.click("expense-correction-undo");
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && ui.query("expense-correction-history-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");

    await act(async () => {
      deferredCorrectionResponses[0]!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).not.toBe("800");
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    await ui.unmount();
  });

  it("restores an off-page acknowledgement after unmount without sharing it across sessions", async () => {
    paginateByAmount = true;
    const originalExpense = listItems[0]!;
    listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...originalExpense, id: `other-${index}`, note: "other expense", effectiveAmount: 900 }))];
    listTotal = listItems.length;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await openSelect(ui.query("expense-sort-by")!);
    await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
    expect(await ui.waitFor(() => lastListInput?.sortBy === "amount" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);

    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    listFails = true;
    historyFails = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => ui.query("expense-correction-saved") !== null && ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null)).toBe(true);
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    await ui.click("expense-correction-dismiss");
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);
    listFails = false;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    expect(await ui.waitFor(() => lastReturnedIds[0] !== "exp-1" && queryClient.isFetching() === 0 && ui.queryAll("expense-row-note").length === lastReturnedIds.length + 1)).toBe(true);
    expect([...ui.queryAll("expense-row-note")].map((note) => note.textContent)).toContain("إيصال قديم");

    listItems = [];
    listTotal = 0;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    expect(await ui.waitFor(() => ui.queryAll("expense-row-note").length === 1 && ui.query("expense-row-note")?.textContent === "إيصال قديم")).toBe(true);
    await ui.unmount();

    const remounted = await mountPage(queryClient);
    expect(await remounted.waitFor(() => remounted.query("expense-row-note")?.textContent === "إيصال قديم")).toBe(true);
    expect(remounted.query("expense-correction-saved")).toBeNull();
    expect(remounted.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);
    await remounted.click("expense-correction-open-history");
    expect(await remounted.waitFor(() => remounted.query("expense-correction-history-error") !== null)).toBe(true);
    expect(remounted.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);
    await remounted.unmount();

    const otherSession = await mountPage(queryClient, "another-session");
    expect(await otherSession.waitFor(() => queryClient.isFetching() === 0)).toBe(true);
    expect(otherSession.query("expense-row-note")).toBeNull();
    await otherSession.unmount();

    const recovered = await mountPage(queryClient);
    expect(await recovered.waitFor(() => recovered.query("expense-row-note")?.textContent === "إيصال قديم")).toBe(true);
    expect(recovered.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    const firstHistory = correctionHistories.get("exp-1")!;
    const laterCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-2",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:40:00",
      beforeAmount: 800,
      afterAmount: 900,
      difference: 100,
      actorId: "actor-2",
      actorName: "مالك المتجر",
      reason: "other session correction",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", { ...firstHistory, effectiveAmount: 900, corrections: [...firstHistory.corrections, laterCorrection] });
    listItems = [{ ...originalExpense, effectiveAmount: 900, correctionCount: 2 }];
    listTotal = 1;
    historyFails = false;
    await recovered.click("expense-correction-amount-retry");
    expect(await recovered.waitFor(() => recovered.query("expense-row-effective-amount")?.getAttribute("data-value") === "900")).toBe(true);
    expect(recovered.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(false);

    await recovered.unmount();
  });

  it.each([false, true])("fails closed for three interposed events when responses arrive in order %s", async (laterResponseFirst) => {
    deferCorrectionResponses = true;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);

    const firstHistory = correctionHistories.get("exp-1")!;
    const interposedCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-2",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:40:00",
      beforeAmount: 800,
      afterAmount: 900,
      difference: 100,
      actorId: "actor-2",
      actorName: "مالك المتجر",
      reason: "other session correction",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", { ...firstHistory, effectiveAmount: 900, corrections: [...firstHistory.corrections, interposedCorrection] });
    listItems = [{ ...listItems[0]!, effectiveAmount: 900, correctionCount: 2 }];
    await ui.type("expense-correction-amount", "700");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && deferredCorrectionResponses.length === 2)).toBe(true);
    expect(correctionInputs[0]?.amount).toBe(800);
    expect(correctionInputs[1]?.amount).toBe(700);

    listFails = true;
    historyFails = true;
    const responseIndexes = laterResponseFirst ? [1, 0] : [0, 1];
    for (const index of responseIndexes) {
      await act(async () => {
        deferredCorrectionResponses[index]!();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(await ui.waitFor(() => ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-row-effective-amount")?.hasAttribute("data-value")).toBe(false);
    expect(ui.query("expense-correction-amount-unverified")).not.toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    listFails = false;
    historyFails = false;
    await ui.click("expense-correction-amount-retry");
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "700")).toBe(true);
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(false);
    expect(ui.queryAll("expense-correction-entry")).toHaveLength(3);

    await ui.unmount();
  });

  it("does not choose the list amount when list and history counts tie but money conflicts", async () => {
    const correction: ExpenseCorrectionHistoryEntry = {
      id: "correction-1",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: "actor-1",
      actorName: "مالك المتجر",
      reason: "first correction",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800,
      corrections: [correction],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 900, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-entry") !== null)).toBe(true);
    expect(ui.query("expense-row-effective-amount")?.hasAttribute("data-value")).toBe(false);
    expect(ui.query("expense-correction-amount-conflict")).not.toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);

    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    await ui.click("expense-correction-amount-conflict-retry");
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "800")).toBe(true);
    expect(ui.query("expense-correction-amount-conflict")).toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(false);

    await ui.unmount();
  });

  it("keeps the later correction when concurrent responses arrive out of order", async () => {
    deferCorrectionResponses = true;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null && ui.query("expense-correction-original") !== null)).toBe(true);

    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);
    await ui.type("expense-correction-amount", "900");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && deferredCorrectionResponses.length === 2)).toBe(true);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(900);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);

    listFails = true;
    historyFails = true;
    await act(async () => {
      deferredCorrectionResponses[1]!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "900" && queryClient.isFetching() === 0)).toBe(true);
    expect(ui.query("expense-correction-amount-unverified")).not.toBeNull();

    await act(async () => {
      deferredCorrectionResponses[0]!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(ui.query("expense-row-effective-amount")?.hasAttribute("data-value")).toBe(false);
    expect(ui.query("expense-correction-amount-unverified")).not.toBeNull();
    expect(ui.query<HTMLButtonElement>("expense-correction-open-editor")?.disabled).toBe(true);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(900);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);

    listFails = false;
    historyFails = false;
    await ui.click("expense-correction-amount-retry");
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "900")).toBe(true);
    expect(correctionInputs).toHaveLength(2);

    await ui.unmount();
  });

  it.each(["history", "list"] as const)("keeps the newer amount when an undo replay arrives with stale %s data", async (staleRead) => {
    const correction: ExpenseCorrectionHistoryEntry = {
      id: "correction-1",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: "actor-1",
      actorName: "مالك المتجر",
      reason: "first correction",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    const correctedHistory: ExpenseCorrectionHistory = {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800,
      corrections: [correction],
    };
    correctionHistories.set("exp-1", correctedHistory);
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.click("expense-correction-undo");
    loseUndoResponse = true;
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && ui.query("expense-correction-undo-confirm") !== null && queryClient.isFetching() === 0)).toBe(true);
    const originalUndoKey = undoInputs[0]!.idempotencyKey;
    const undoneHistory = correctionHistories.get("exp-1")!;
    const laterCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-3",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:45:00",
      beforeAmount: 1_000,
      afterAmount: 900,
      difference: -100,
      actorId: "actor-2",
      actorName: "مالك المتجر",
      reason: "later verified amount",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      ...undoneHistory,
      effectiveAmount: 900,
      corrections: [...undoneHistory.corrections, laterCorrection],
    });
    if (staleRead === "history") {
      historyResponseOverride = undoneHistory;
      listItems[0] = { ...listItems[0]!, effectiveAmount: 900, correctionCount: 3 };
    }
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    if (staleRead === "list") {
      listItems[0] = { ...listItems[0]!, effectiveAmount: 1_000, correctionCount: 2 };
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
      await ui.click("expense-correction-open-history");
      await ui.click("expense-correction-open-history");
    }
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "900")).toBe(true);

    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 2 && queryClient.isFetching() === 0)).toBe(true);
    expect(undoInputs[1]?.idempotencyKey).toBe(originalUndoKey);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(3);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(900);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("900");

    await ui.unmount();
  });

  it("keeps newer list money when an older history remains cached", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    expect(queryClient.getQueryData<ExpenseCorrectionHistory>(["expenseCorrectionHistory", "exp-1"])?.effectiveAmount).toBe(1_000);
    listItems = [{ ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 }];
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "800")).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    await ui.type("expense-correction-amount", "700");
    await ui.type("expense-correction-reason", "keep this draft");
    listItems = [];
    listTotal = 0;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["expenses"] }); });
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("800");
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("700");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("keep this draft");
    expect(queryClient.getQueryData<ExpenseCorrectionHistory>(["expenseCorrectionHistory", "exp-1"])?.effectiveAmount).toBe(1_000);
    await ui.unmount();
  });

  it("lets the server refuse an unchanged amount", async () => {
    correctionFailuresRemaining = 1;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => ui.query("expense-correction-error") !== null)).toBe(true);
    expect(correctionInputs).toHaveLength(1);
    expect(correctionInputs[0]?.amount).toBe(1_000);
    expect(ui.query("expense-correction-error")?.textContent).toBe(i18n.t("EXPENSE_CORRECTION_NO_CHANGE"));
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("1000");
    expect(ui.query("expense-correction-saved")).toBeNull();
    await ui.unmount();
  });

  it.each(["changed request", "refreshed amount"])("uses authoritative off-page correction history for %s", async (assertion) => {
    paginateByAmount = true;
    listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, effectiveAmount: 900 }))];
    listTotal = listItems.length;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await openSelect(ui.query("expense-sort-by")!);
    await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
    expect(await ui.waitFor(() => queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.type("expense-correction-reason", "restore after lost acknowledgement");
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => !lastReturnedIds.includes("exp-1") && queryClient.isFetching() === 0 && ui.query("expense-correction-entry") !== null)).toBe(true);
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("restore after lost acknowledgement");
    expect(ui.query("expense-correction-error")).not.toBeNull();
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(correctionInputs).toHaveLength(1);
    if (assertion === "refreshed amount") {
      const retainedRow = ui.query("expense-correction-history")!.closest("tr")!.previousElementSibling!;
      expect(retainedRow.querySelector('[data-testid="expense-row-effective-amount"]')?.getAttribute("data-value")).toBe("800");
    } else {
      const historyAfterLostResponse = correctionHistories.get("exp-1")!;
      const externalCorrection: ExpenseCorrectionHistoryEntry = {
        id: "external-after-lost-response", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:40:00",
        beforeAmount: 800, afterAmount: 900, difference: 100, actorId: "actor-2", actorName: "مالك المتجر",
        reason: "external event", reversesCorrectionId: null, reversedByCorrectionId: null,
      };
      correctionHistories.set("exp-1", { ...historyAfterLostResponse, effectiveAmount: 900, corrections: [...historyAfterLostResponse.corrections, externalCorrection] });
      listItems[0] = { ...listItems[0]!, effectiveAmount: 900, correctionCount: 2 };
      await ui.click("expense-correction-amount-retry");
      expect(await ui.waitFor(() => ui.query("expense-correction-history")?.querySelectorAll('[data-testid="expense-correction-entry"]').length === 2 && queryClient.isFetching() === 0)).toBe(true);
      expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("900");
      await ui.type("expense-correction-amount", "1000");
      await ui.submit("expense-correction-form");
      expect(ui.query("expense-correction-discard-confirmation")).not.toBeNull();
      expect(correctionInputs).toHaveLength(1);
      expect(ui.query("expense-correction-discard-confirmation")?.getAttribute("role")).toBe("alert");
      await ui.click("expense-correction-discard-cancel");
      expect(ui.query("expense-correction-discard-confirmation")).toBeNull();
      expect(correctionInputs).toHaveLength(1);
      await ui.submit("expense-correction-form");
      expect(ui.query("expense-correction-discard-confirmation")).not.toBeNull();
      await ui.click("expense-correction-discard-confirm");
      expect(await ui.waitFor(() => correctionInputs.length === 2)).toBe(true);
      expect(correctionInputs[1]).toMatchObject({ expenseId: "exp-1", amount: 1_000, reason: "restore after lost acknowledgement" });
      expect(correctionInputs[1]?.idempotencyKey).not.toBe(correctionInputs[0]?.idempotencyKey);
      expect(await ui.waitFor(() => ui.query("expense-correction-form") === null)).toBe(true);
      expect(ui.query("expense-correction-error")).toBeNull();
      expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");
    }
    await ui.unmount();
  });

  it.each(["list error", "page removal", "history error"])("retains exact undo recovery after %s", async (incident) => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-original") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    if (incident === "page removal") {
      paginateByAmount = true;
      listItems = [...listItems, ...Array.from({ length: 100 }, (_, index) => ({ ...listItems[0]!, id: `other-${index}`, effectiveAmount: 900 }))];
      listTotal = listItems.length;
      await openSelect(ui.query("expense-sort-dir")!);
      await activateOption((await findOption(i18n.t("expensesSortAsc")))!);
      expect(await ui.waitFor(() => queryClient.isFetching() === 0)).toBe(true);
      await openSelect(ui.query("expense-sort-by")!);
      await activateOption((await findOption(i18n.t("expensesSortByAmount")))!);
      expect(await ui.waitFor(() => lastListInput?.sortDir === "asc" && queryClient.isFetching() === 0 && lastReturnedIds[0] === "exp-1")).toBe(true);
    }
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "700");
    await ui.type("expense-correction-reason", "next draft");
    await ui.click("expense-correction-undo");
    listFails = incident === "list error";
    historyFails = incident === "history error";
    loseUndoResponse = true;
    await ui.click("expense-correction-undo-confirm-button");
    if (incident === "list error") {
      expect(await ui.waitFor(() => ui.query("expenses-history-error") !== null)).toBe(true);
    } else if (incident === "page removal") {
      expect(await ui.waitFor(() => !lastReturnedIds.includes("exp-1"))).toBe(true);
    } else {
      expect(await ui.waitFor(() => ui.query("expense-correction-history-error") !== null)).toBe(true);
    }
    expect(ui.query("expense-correction-undo-confirm")).not.toBeNull();
    expect(ui.query("expense-correction-history")?.querySelector('[role="alert"]')).not.toBeNull();
    expect(ui.query("expense-correction-saved")).toBeNull();
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("700");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("next draft");
    expect(undoInputs).toHaveLength(1);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    if (incident === "page removal") {
      expect(await ui.waitFor(() => queryClient.isFetching() === 0 && ui.query("expense-correction-history")?.querySelectorAll('[data-testid="expense-correction-entry"]').length === 2)).toBe(true);
      const retainedRow = ui.query("expense-correction-history")!.closest("tr")!.previousElementSibling!;
      expect(retainedRow.querySelector('[data-testid="expense-row-effective-amount"]')?.getAttribute("data-value")).toBe("1000");
    }
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 2 && ui.query("expense-correction-undo-confirm") === null)).toBe(true);
    expect(undoInputs[1]).toEqual(undoInputs[0]);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(1_000);
    expect(ui.query("expense-correction-saved")?.textContent).toBe(i18n.t("expenseCorrectionUndoSaved"));
    await ui.unmount();
  });

  it.each([true, false])("keeps a remounted undo retry key across both completion orders, correction first: %s", async (correctionFirst) => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: "actor-1", actorName: "مالك المتجر",
      reason: "receipt typo", reversesCorrectionId: null, reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800, corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    deferCorrectionResponses = true;
    const oldRow = await mountPage(queryClient);
    expect(await oldRow.waitFor(() => oldRow.query("expense-correction-open-history") !== null)).toBe(true);
    await oldRow.click("expense-correction-open-history");
    await oldRow.click("expense-correction-open-editor");
    await oldRow.type("expense-correction-amount", "700");
    await oldRow.submit("expense-correction-form");
    expect(await oldRow.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);
    await oldRow.unmount();

    deferUndoResponses = true;
    loseUndoResponse = true;
    const remounted = await mountPage(queryClient);
    expect(await remounted.waitFor(() => remounted.query("expense-correction-open-history") !== null)).toBe(true);
    await remounted.click("expense-correction-open-history");
    expect(await remounted.waitFor(() => remounted.query("expense-correction-undo") !== null)).toBe(true);
    await remounted.click("expense-correction-undo");
    await remounted.click("expense-correction-undo-confirm-button");
    expect(await remounted.waitFor(() => undoInputs.length === 1 && deferredUndoResponses.length === 1)).toBe(true);
    const exactUndoRequest = undoInputs[0]!;
    const recoveryKey = expenseCorrectionRecoveryQueryKey("test-session");
    const resolveCorrection = async () => act(async () => { deferredCorrectionResponses[0]!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const resolveUncertainUndo = async () => act(async () => { deferredUndoResponses[0]!(true); await new Promise((resolve) => setTimeout(resolve, 20)); });
    if (correctionFirst) {
      await resolveCorrection();
      expect(queryClient.getQueryData<{ "exp-1"?: { undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"]?.undoRequests["correction-1"]).toBe(exactUndoRequest.idempotencyKey);
      await resolveUncertainUndo();
    } else {
      await resolveUncertainUndo();
      expect(queryClient.getQueryData<{ "exp-1"?: { undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"]?.undoRequests["correction-1"]).toBe(exactUndoRequest.idempotencyKey);
      await resolveCorrection();
    }
    expect(queryClient.getQueryData<{ "exp-1"?: { undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"]?.undoRequests["correction-1"]).toBe(exactUndoRequest.idempotencyKey);
    await remounted.click("expense-correction-undo-confirm-button");
    expect(await remounted.waitFor(() => undoInputs.length === 2)).toBe(true);
    expect(undoInputs[1]).toEqual(exactUndoRequest);
    await remounted.unmount();
  });

  it.each([false, true])("does not restore an acknowledged correction when an undo finishes later, lost undo response: %s", async (loseUndoAck) => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: "actor-1", actorName: "مالك المتجر",
      reason: "receipt typo", reversesCorrectionId: null, reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800, corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    await ui.type("expense-correction-amount", "700");

    deferCorrectionResponses = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);
    const recoveryKey = expenseCorrectionRecoveryQueryKey("test-session");
    const correctionKey = correctionInputs[0]!.idempotencyKey;
    expect(queryClient.getQueryData<{ "exp-1"?: { correctionRequest: { idempotencyKey: string } | null } }>(recoveryKey)?.["exp-1"]?.correctionRequest?.idempotencyKey).toBe(correctionKey);

    deferUndoResponses = true;
    await ui.click("expense-correction-undo");
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && deferredUndoResponses.length === 1)).toBe(true);
    const undoKey = undoInputs[0]!.idempotencyKey;

    await act(async () => { deferredCorrectionResponses[0]!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(await ui.waitFor(() => queryClient.getQueryData<{ "exp-1"?: { correctionRequest: unknown } }>(recoveryKey)?.["exp-1"]?.correctionRequest === null)).toBe(true);
    await act(async () => { deferredUndoResponses[0]!(loseUndoAck); await new Promise((resolve) => setTimeout(resolve, 20)); });

    const recoveryAfterUndo = queryClient.getQueryData<{ "exp-1"?: { correctionRequest: unknown; undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"];
    expect(recoveryAfterUndo?.correctionRequest).toBeNull();
    expect(recoveryAfterUndo?.undoRequests["correction-1"]).toBe(loseUndoAck ? undoKey : undefined);
    if (!loseUndoAck) expect(ui.query("expense-correction-amount-unverified")).toBeNull();
    if (loseUndoAck) {
      await ui.click("expense-correction-undo-confirm-button");
      expect(await ui.waitFor(() => undoInputs.length === 2)).toBe(true);
      expect(undoInputs[1]?.idempotencyKey).toBe(undoKey);
    }
    expect(correctionInputs).toHaveLength(1);
    expect(correctionInputs[0]?.idempotencyKey).toBe(correctionKey);
    await ui.unmount();
  });

  it("preserves a pending correction and exact undo retry key when undo fails first", async () => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: "actor-1", actorName: "مالك المتجر",
      reason: "receipt typo", reversesCorrectionId: null, reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800, corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    await ui.type("expense-correction-amount", "700");

    deferCorrectionResponses = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && deferredCorrectionResponses.length === 1)).toBe(true);
    const recoveryKey = expenseCorrectionRecoveryQueryKey("test-session");
    const correctionKey = correctionInputs[0]!.idempotencyKey;
    deferUndoResponses = true;
    await ui.click("expense-correction-undo");
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && deferredUndoResponses.length === 1)).toBe(true);
    const undoKey = undoInputs[0]!.idempotencyKey;

    await act(async () => { deferredUndoResponses[0]!(true); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const recoveryAfterUndoFailure = queryClient.getQueryData<{ "exp-1"?: { correctionRequest: { idempotencyKey: string } | null; undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"];
    expect(recoveryAfterUndoFailure?.correctionRequest?.idempotencyKey).toBe(correctionKey);
    expect(recoveryAfterUndoFailure?.undoRequests["correction-1"]).toBe(undoKey);

    await act(async () => { deferredCorrectionResponses[0]!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const recoveryAfterCorrection = queryClient.getQueryData<{ "exp-1"?: { correctionRequest: unknown; undoRequests: Record<string, string> } }>(recoveryKey)?.["exp-1"];
    expect(recoveryAfterCorrection?.correctionRequest).toBeNull();
    expect(recoveryAfterCorrection?.undoRequests["correction-1"]).toBe(undoKey);

    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 2)).toBe(true);
    expect(undoInputs[1]?.idempotencyKey).toBe(undoKey);
    expect(correctionInputs).toHaveLength(1);
    expect(correctionInputs[0]?.idempotencyKey).toBe(correctionKey);
    await ui.unmount();
  });

  it("keeps a lost correction keyed and unchanged across cancellation, remount, failed reads, and sessions", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.type("expense-correction-reason", "same request");
    listFails = true;
    historyFails = true;
    loseCorrectionResponse = true;
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expenses-history-error") !== null && ui.query("expense-correction-history-error") !== null)).toBe(true);
    const originalRequest = correctionInputs[0]!;
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");

    await ui.click("expense-correction-cancel");
    expect(ui.query("expense-correction-form")).toBeNull();
    await ui.click("expense-correction-open-editor");
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(ui.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("same request");
    await ui.type("expense-correction-amount", "700");
    await ui.submit("expense-correction-form");
    expect(correctionInputs).toHaveLength(1);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");
    await ui.unmount();

    const remounted = await mountPage(queryClient);
    expect(await remounted.waitFor(() => remounted.query("expense-correction-open-editor") !== null)).toBe(true);
    await remounted.click("expense-correction-open-editor");
    expect(await remounted.waitFor(() => remounted.query("expense-correction-form") !== null)).toBe(true);
    expect(remounted.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("800");
    expect(remounted.query<HTMLTextAreaElement>("expense-correction-reason")?.value).toBe("same request");
    const firstHistory = correctionHistories.get("exp-1")!;
    const laterCorrection: ExpenseCorrectionHistoryEntry = {
      id: "external-correction", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:40:00",
      beforeAmount: 800, afterAmount: 900, difference: 100, actorId: "actor-2", actorName: "مالك المتجر",
      reason: "external event", reversesCorrectionId: null, reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", { ...firstHistory, effectiveAmount: 900, corrections: [...firstHistory.corrections, laterCorrection] });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 900, correctionCount: 2 };
    listFails = false;
    historyFails = false;
    await remounted.submit("expense-correction-form");
    expect(await remounted.waitFor(() => correctionInputs.length === 2)).toBe(true);
    expect(correctionInputs[1]).toEqual(originalRequest);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(900);
    expect(remounted.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("900");
    await remounted.unmount();

    const otherSession = await mountPage(queryClient, "different-session");
    expect(await otherSession.waitFor(() => queryClient.isFetching() === 0)).toBe(true);
    expect(otherSession.query("expense-correction-form")).toBeNull();
    expect(otherSession.query("expense-correction-amount-unverified")).toBeNull();
    await otherSession.unmount();
  });

  it.each(["remount", "cancel after refreshed history"])("restores a lost undo confirmation and its key after %s", async (recoveryPath) => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: "actor-1", actorName: "مالك المتجر",
      reason: "receipt typo", reversesCorrectionId: null, reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800, corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    await ui.click("expense-correction-undo");
    historyFails = true;
    listFails = true;
    loseUndoResponse = true;
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && ui.query("expense-correction-undo-confirm") !== null)).toBe(true);
    const originalUndo = undoInputs[0]!;
    if (recoveryPath === "remount") await ui.unmount();

    const remounted = recoveryPath === "remount" ? await mountPage(queryClient) : ui;
    expect(await remounted.waitFor(() => remounted.query("expense-correction-open-history") !== null)).toBe(true);
    if (recoveryPath === "remount") {
      await remounted.click("expense-correction-open-history");
    } else {
      historyFails = false;
      listFails = false;
      await remounted.click("expense-correction-amount-retry");
      expect(await remounted.waitFor(() => remounted.queryAll("expense-correction-entry").length === 2 && queryClient.isFetching() === 0)).toBe(true);
      await remounted.click("expense-correction-undo-cancel");
      expect(remounted.query("expense-correction-undo-confirm")).toBeNull();
      expect(remounted.query("expense-correction-amount-unverified")).not.toBeNull();
      expect(remounted.query("expense-correction-undo")?.textContent).toBe(i18n.t("expenseCorrectionRetry"));
      await remounted.click("expense-correction-undo");
    }
    expect(await remounted.waitFor(() => remounted.query("expense-correction-undo-confirm") !== null)).toBe(true);
    expect(remounted.query("expense-correction-undo-confirm")).not.toBeNull();
    await remounted.click("expense-correction-undo-confirm-button");
    expect(await remounted.waitFor(() => undoInputs.length === 2)).toBe(true);
    expect(undoInputs[1]).toEqual(originalUndo);
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    await remounted.unmount();
  });

  it.each(["EXPENSE_CORRECTION_NO_CHANGE", "EXPENSE_CORRECTION_BELOW_REFUNDED"])("clears definitive %s so a corrected draft can proceed", async (message) => {
    correctionFailureMessage = message;
    correctionFailuresRemaining = 1;
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => ui.query("expense-correction-error") !== null)).toBe(true);
    expect(correctionInputs).toHaveLength(1);
    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 2 && ui.query("expense-correction-form") === null)).toBe(true);
    expect(correctionInputs[1]?.amount).toBe(800);
    expect(correctionInputs[1]?.idempotencyKey).not.toBe(correctionInputs[0]?.idempotencyKey);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(800);
    await ui.unmount();
  });

  it("clears a definitive below-refunded undo refusal before a new attempt", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    await ui.type("expense-correction-amount", "800");
    await ui.submit("expense-correction-form");
    expect(await ui.waitFor(() => correctionInputs.length === 1 && ui.query("expense-correction-form") === null)).toBe(true);
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);
    correctionFailureMessage = "EXPENSE_CORRECTION_BELOW_REFUNDED";
    correctionFailuresRemaining = 1;
    await ui.click("expense-correction-undo");
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 1 && queryClient.isFetching() === 0)).toBe(true);
    const recovery = queryClient.getQueryData<Record<string, { undoRequests: Record<string, string> }>>(expenseCorrectionRecoveryQueryKey("test-session"));
    expect(recovery?.["exp-1"]).toBeDefined();
    expect(recovery?.["exp-1"]?.undoRequests["correction-1"]).toBeUndefined();
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => undoInputs.length === 2 && ui.query("expense-correction-undo-confirm") === null)).toBe(true);
    expect(undoInputs[1]?.idempotencyKey).not.toBe(undoInputs[0]?.idempotencyKey);
    await ui.unmount();
  });

  it("shows linked identifiers for non-latest reversal entries", async () => {
    const first: ExpenseCorrectionHistoryEntry = {
      id: "correction-1", expenseId: "exp-1", effectiveAt: "2019-12-15T10:00:00", recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: "actor-1", actorName: "مالك المتجر",
      reason: "first", reversesCorrectionId: null, reversedByCorrectionId: "correction-3",
    };
    const second: ExpenseCorrectionHistoryEntry = {
      ...first, id: "correction-2", beforeAmount: 800, afterAmount: 700, difference: -100,
      reason: "second", reversedByCorrectionId: null,
    };
    const reversal: ExpenseCorrectionHistoryEntry = {
      ...first, id: "correction-3", beforeAmount: 700, afterAmount: 900, difference: 200,
      reason: null, reversesCorrectionId: "correction-1", reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 900, corrections: [first, second, reversal],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 900, correctionCount: 3 };
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.queryAll("expense-correction-entry").length === 3)).toBe(true);
    for (const id of ["correction-1", "correction-2", "correction-3"]) {
      const item = [...ui.queryAll<HTMLElement>("expense-correction-entry")].find((entry) => entry.id === `expense-correction-entry-${id}`);
      expect(item).not.toBeUndefined();
      expect(item?.textContent).toContain(id);
    }
    const entries = [...ui.queryAll<HTMLElement>("expense-correction-entry")];
    const reversalItem = entries.find((entry) => entry.id === "expense-correction-entry-correction-3")!;
    const firstItem = entries.find((entry) => entry.id === "expense-correction-entry-correction-1")!;
    expect(reversalItem.querySelector('a[href="#expense-correction-entry-correction-1"]')?.textContent).toBe("correction-1");
    expect(firstItem.querySelector('a[href="#expense-correction-entry-correction-3"]')?.textContent).toBe("correction-3");
    await ui.unmount();
  });

  it("cancels an unsent correction without changing the effective amount", async () => {
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-editor") !== null)).toBe(true);
    await ui.click("expense-correction-open-editor");
    expect(await ui.waitFor(() => ui.query("expense-correction-form") !== null)).toBe(true);
    await ui.type("expense-correction-amount", "800");
    await ui.click("expense-correction-cancel");

    expect(ui.query("expense-correction-form")).toBeNull();
    expect(correctionInputs).toHaveLength(0);
    expect(ui.query("expense-row-effective-amount")?.getAttribute("data-value")).toBe("1000");

    await ui.unmount();
  });

  it.each([false, true])("requires undo confirmation and reconciles a linked reversal, lost response: %s", async (lostResponse) => {
    const priorCorrection: ExpenseCorrectionHistoryEntry = {
      id: "correction-1",
      expenseId: "exp-1",
      effectiveAt: "2019-12-15T10:00:00",
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: "actor-1",
      actorName: "مالك المتجر",
      reason: "receipt typo",
      reversesCorrectionId: null,
      reversedByCorrectionId: null,
    };
    correctionHistories.set("exp-1", {
      original: { id: "exp-1", categoryId: "cat-1", amount: 1_000, note: "إيصال قديم", occurredAt: "2019-12-15T10:00:00", createdAt: "2019-12-16T11:00:00", actorId: null, actorName: null },
      effectiveAmount: 800,
      corrections: [priorCorrection],
    });
    listItems[0] = { ...listItems[0]!, effectiveAmount: 800, correctionCount: 1 };
    report.subscribe(() => {});
    const ui = await mountPage(queryClient);
    expect(await ui.waitFor(() => ui.query("expense-correction-open-history") !== null)).toBe(true);
    await ui.click("expense-correction-open-history");
    expect(await ui.waitFor(() => ui.query("expense-correction-undo") !== null)).toBe(true);

    await ui.click("expense-correction-undo");
    expect(ui.query("expense-correction-undo-confirm")).not.toBeNull();
    await ui.click("expense-correction-undo-cancel");
    expect(undoInputs).toHaveLength(0);
    expect(correctionHistories.get("exp-1")?.effectiveAmount).toBe(800);

    expect(report.getCurrentResult().data?.operatingExpenses).toBe(800);
    await ui.click("expense-correction-open-editor");
    await ui.type("expense-correction-amount", "700");
    await ui.type("expense-correction-reason", "next correction draft");
    loseUndoResponse = lostResponse;
    await ui.click("expense-correction-undo");
    await ui.click("expense-correction-undo-confirm-button");
    expect(await ui.waitFor(() => ui.query("expense-row-effective-amount")?.getAttribute("data-value") === "1000")).toBe(true);
    expect(await ui.waitFor(() => report.getCurrentResult().data?.operatingExpenses === 1_000)).toBe(true);
    expect(await ui.waitFor(() => ui.query("expense-correction-history")?.querySelectorAll('[data-testid="expense-correction-entry"]').length === 2)).toBe(true);
    expect(ui.query("expense-correction-entry")?.textContent).toContain(i18n.t("expenseCorrectionReversedBy"));
    expect(ui.query("expense-correction-undo")).toBeNull();
    expect(ui.query<HTMLInputElement>("expense-correction-amount")?.value).toBe("700");
    expect(ui.query<HTMLInputElement>("expense-correction-reason")?.value).toBe("next correction draft");
    expect(undoInputs).toHaveLength(1);
    if (lostResponse) {
      expect(ui.query("expense-correction-history")?.querySelector('[role="alert"]')).not.toBeNull();
      expect(ui.query("expense-correction-saved")).toBeNull();
      expect(ui.query("expense-correction-undo-confirm")).not.toBeNull();
      const firstKey = undoInputs[0]!.idempotencyKey;
      await ui.click("expense-correction-undo-confirm-button");
      expect(await ui.waitFor(() => ui.query("expense-correction-undo-confirm") === null)).toBe(true);
      expect(undoInputs).toHaveLength(2);
      expect(undoInputs[1]!.idempotencyKey).toBe(firstKey);
      expect(ui.query("expense-correction-history")?.querySelector('[role="alert"]')).toBeNull();
      expect(ui.query("expense-correction-saved")?.textContent).toBe(i18n.t("expenseCorrectionUndoSaved"));
      expect(ui.query("expense-correction-history")?.querySelectorAll('[data-testid="expense-correction-entry"]').length).toBe(2);
      expect(report.getCurrentResult().data?.operatingExpenses).toBe(1_000);
    }
    expect(correctionHistories.get("exp-1")?.corrections).toHaveLength(2);
    expect(correctionHistories.get("exp-1")?.corrections[1]).toMatchObject({
      beforeAmount: 800,
      afterAmount: 1_000,
      difference: 200,
      reversesCorrectionId: "correction-1",
    });

    await ui.unmount();
  });
});
