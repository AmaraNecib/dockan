import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { QueryObserver } from "@tanstack/react-query";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";

interface Category {
  id: string;
  name: string;
}

let categories: Category[] = [];
let created: Array<{ name: string }> = [];
let categoryRenameFails = false;
let categoryDeleteFails = false;
let categoryUseCounts = new Map<string, number>();
let categoryCreateDelay: Promise<void> | null = null;
let releaseCategoryCreate: (() => void) | null = null;
let categoryRenameDelay: Promise<void> | null = null;
let releaseCategoryRename: (() => void) | null = null;
let categoryDeleteDelay: Promise<void> | null = null;
let releaseCategoryDelete: (() => void) | null = null;

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration and exposes every member the
// page touches, including queryKey — the create success path invalidates by it.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({
        queryKey: [["categoriesList"]],
        queryFn: async () => ({ items: categories }),
      }),
      queryKey: () => [["categoriesList"]],
    },
    itemsList: { queryKey: () => [["itemsList"]] },
    itemsAll: { queryKey: () => [["itemsAll"]] },
    categoriesRename: {
      mutationOptions: (options: { onSuccess?: (category: Category) => void; onError?: (error: { message?: string }) => void }) => ({
        mutationKey: ["categoriesRename"],
        ...options,
        mutationFn: async (input: { id: string; name: string }) => {
          if (categoryRenameFails) throw new Error("CATEGORY_EXISTS");
          await categoryRenameDelay;
          const category = categories.find((row) => row.id === input.id);
          if (category === undefined) throw new Error("CATEGORY_NOT_FOUND");
          category.name = input.name.trim();
          return category;
        },
      }),
    },
    categoriesDelete: {
      mutationOptions: (options: { onSuccess?: (result: { deleted: boolean; itemCount: number }) => void; onError?: (error: { message?: string }) => void }) => ({
        mutationKey: ["categoriesDelete"],
        ...options,
        mutationFn: async (input: { id: string }) => {
          if (categoryDeleteFails) throw new Error("CATEGORY_NOT_FOUND");
          await categoryDeleteDelay;
          const itemCount = categoryUseCounts.get(input.id) ?? 0;
          if (itemCount > 0) return { deleted: false, itemCount };
          categories = categories.filter((row) => row.id !== input.id);
          return { deleted: true, itemCount: 0 };
        },
      }),
    },
    categoriesCreate: {
      mutationOptions: (options: { onSuccess?: () => void; onError?: (error: { message?: string }) => void }) => ({
        mutationKey: ["categoriesCreate"],
        ...options,
        mutationFn: async (input: { name: string }) => {
          created.push(input);
          await categoryCreateDelay;
          const row = { id: `cat-${created.length}`, name: input.name };
          categories.push(row);
          return row;
        },
      }),
    },
  },
  rpcClient: {},
}));

const { CategoriesPage } = await import("./categories");

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (button === undefined) throw new Error(`missing button: ${label}`);
  await act(async () => button.click());
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

async function mount() {
  const page = await mountWithProviders(<CategoriesPage />);
  await page.poll(
    () => page.query("categories-empty") !== null || page.container.querySelector("ul") !== null,
    "categories settled",
  );
  return page;
}

beforeEach(() => {
  categories = [];
  created = [];
  categoryRenameFails = false;
  categoryDeleteFails = false;
  categoryUseCounts = new Map();
  categoryCreateDelay = null;
  releaseCategoryCreate = null;
  categoryRenameDelay = null;
  releaseCategoryRename = null;
  categoryDeleteDelay = null;
  releaseCategoryDelete = null;
  document.body.innerHTML = "";
});

afterEach(async () => {
  await unmountAllMountedPages();
  document.body.innerHTML = "";
});

describe("CategoriesPage management (#389)", () => {
  it("renames a category with the same ID and keeps the edit available after a save failure", async () => {
    categories = [{ id: "cat-stable", name: "قديم" }];
    const page = await mount();
    await clickButton(page.container, i18n.t("categoriesRename"));
    const input = page.container.querySelector<HTMLInputElement>('input[aria-label="اسم التصنيف قديم"]')!;
    typeInto(input, "جديد");
    categoryRenameFails = true;
    await submitForm(input.closest("form")!);

    await page.poll(() => page.container.textContent?.includes(i18n.t("CATEGORY_EXISTS")) === true, "rename failure shown");
    expect(categories).toEqual([{ id: "cat-stable", name: "قديم" }]);
    expect(page.container.querySelector('input[aria-label="اسم التصنيف قديم"]')).not.toBeNull();

    categoryRenameFails = false;
    await submitForm(page.container.querySelector("li form")!);
    await page.poll(() => page.container.textContent?.includes("جديد") === true, "renamed label shown");
    expect(categories).toEqual([{ id: "cat-stable", name: "جديد" }]);
  });

  it("locks other row actions and the draft while a rename is pending", async () => {
    categories = [
      { id: "cat-a", name: "أ" },
      { id: "cat-b", name: "ب" },
    ];
    categoryRenameDelay = new Promise((resolve) => { releaseCategoryRename = resolve; });
    const page = await mount();
    const renameButtons = [...page.container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === i18n.t("categoriesRename"));
    await act(async () => renameButtons[0]?.click());
    const editor = page.container.querySelector<HTMLInputElement>('input[aria-label="اسم التصنيف أ"]')!;
    typeInto(editor, "أ جديد");
    await submitForm(editor.closest("form")!);

    const otherRename = [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === i18n.t("categoriesRename"));
    const interactionsLocked = editor.disabled && otherRename?.disabled === true;
    releaseCategoryRename?.();
    await page.poll(() => categories[0]?.name === "أ جديد", "delayed rename completes");

    expect(interactionsLocked).toBe(true);
    expect(page.container.textContent).toContain("ب");
  });

  it("locks other row actions while a delete is pending", async () => {
    categories = [
      { id: "cat-a", name: "أ" },
      { id: "cat-b", name: "ب" },
    ];
    categoryDeleteDelay = new Promise((resolve) => { releaseCategoryDelete = resolve; });
    const page = await mount();
    const deleteButtons = [...page.container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === i18n.t("categoriesDelete"));
    await act(async () => deleteButtons[0]?.click());
    await clickButton(page.container, i18n.t("categoriesConfirm"));

    const otherDelete = [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === i18n.t("categoriesDelete"));
    const interactionsLocked = otherDelete?.disabled === true;
    releaseCategoryDelete?.();
    await page.poll(() => categories.length === 1, "delayed delete completes");

    expect(interactionsLocked).toBe(true);
    expect(categories).toEqual([{ id: "cat-b", name: "ب" }]);
  });

  it("locks the create field while a category create is pending", async () => {
    categoryCreateDelay = new Promise((resolve) => { releaseCategoryCreate = resolve; });
    const page = await mount();
    const input = page.container.querySelector<HTMLInputElement>('input[placeholder="اسم تصنيف جديد"]')!;
    typeInto(input, "أول تصنيف");
    await submitForm(input.closest("form")!);

    const draftLocked = input.disabled;
    releaseCategoryCreate?.();
    await page.poll(() => categories.length === 1, "delayed create completes");

    expect(draftLocked).toBe(true);
  });

  it("refreshes cached item-list pages with the real nested oRPC key after rename", async () => {
    categories = [{ id: "cat-stable", name: "قديم" }];
    const page = await mount();
    const itemListKeys = [
      [["itemsList"], { input: { page: 1 } }],
      [["itemsList"], { input: { page: 2 } }],
    ] as const;
    const observers = itemListKeys.map((queryKey) => new QueryObserver(page.queryClient, {
      queryKey,
      queryFn: async () => ({ categoryName: categories[0]?.name }),
    }));
    const unsubscribers = observers.map((observer) => observer.subscribe(() => undefined));
    await Promise.all(observers.map((observer) => observer.refetch()));
    expect(observers.map((observer) => observer.getCurrentResult().data?.categoryName)).toEqual(["قديم", "قديم"]);

    await clickButton(page.container, i18n.t("categoriesRename"));
    typeInto(page.container.querySelector<HTMLInputElement>('input[aria-label="اسم التصنيف قديم"]')!, "جديد");
    await submitForm(page.container.querySelector("li form")!);
    await page.poll(
      () => observers.every((observer) => observer.getCurrentResult().data?.categoryName === "جديد"),
      "cached item-list labels refreshed",
    );

    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it("cancels an edit and a delete confirmation without changing the category", async () => {
    categories = [{ id: "cat-stable", name: "قديم" }];
    const page = await mount();
    await clickButton(page.container, i18n.t("categoriesRename"));
    typeInto(page.container.querySelector<HTMLInputElement>('input[aria-label="اسم التصنيف قديم"]')!, "مسودة");
    await clickButton(page.container, i18n.t("categoriesCancel"));
    expect(categories[0]?.name).toBe("قديم");

    await clickButton(page.container, i18n.t("categoriesDelete"));
    expect(page.container.textContent).toContain(i18n.t("categoriesConfirmDelete", { name: "قديم" }));
    await clickButton(page.container, i18n.t("categoriesCancel"));
    expect(categories).toEqual([{ id: "cat-stable", name: "قديم" }]);
  });

  it("keeps delete confirmation open after a failure and allows retry", async () => {
    categories = [{ id: "cat-retry", name: "قابل للحذف" }];
    const page = await mount();
    await clickButton(page.container, i18n.t("categoriesDelete"));
    categoryDeleteFails = true;
    await clickButton(page.container, i18n.t("categoriesConfirm"));
    await page.poll(() => page.container.querySelector('[role="alert"]') !== null, "delete failure shown");
    expect(categories).toEqual([{ id: "cat-retry", name: "قابل للحذف" }]);
    expect([...page.container.querySelectorAll("button")].some((button) => button.textContent === i18n.t("categoriesConfirm"))).toBe(true);

    categoryDeleteFails = false;
    await clickButton(page.container, i18n.t("categoriesConfirm"));
    await page.poll(() => categories.length === 0, "delete retry succeeded");
    expect(categories).toEqual([]);
  });

  it("shows the actual linked-item count and keeps a used category", async () => {
    categories = [{ id: "cat-used", name: "مستخدم" }];
    categoryUseCounts.set("cat-used", 4);
    const page = await mount();
    await clickButton(page.container, i18n.t("categoriesDelete"));
    await clickButton(page.container, i18n.t("categoriesConfirm"));

    expect(page.container.textContent).toContain(i18n.t("categoriesUsed", { count: 4 }));
    expect(categories).toEqual([{ id: "cat-used", name: "مستخدم" }]);
  });

  it("shows a distinct no-results state for an unmatched search", async () => {
    categories = [{ id: "cat-1", name: "بطاريات" }];
    const page = await mount();
    typeInto(page.container.querySelector<HTMLInputElement>('input[type="search"]')!, "غير موجود");

    expect(page.container.textContent).toContain(i18n.t("categoriesNoMatches"));
  });

  it("searches categories from the complete category list", async () => {
    categories = Array.from({ length: 35 }, (_, index) => ({ id: `cat-${index}`, name: `تصنيف ${index}` }));
    categories.push({ id: "cat-last", name: "بطاريات خاصة" });
    const page = await mount();

    const search = page.container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    typeInto(search!, "بطاريات خاصة");

    expect(page.container.textContent).toContain("بطاريات خاصة");
    expect(page.container.textContent).not.toContain("تصنيف 0");
  });
});

describe("CategoriesPage empty state (issue #96)", () => {
  it("names the next step and focuses the adjacent add field", async () => {
    const page = await mount();

    const empty = page.query("categories-empty");
    expect(empty?.textContent).toContain(i18n.t("categoriesEmpty"));
    expect(empty?.textContent).toContain(i18n.t("categoriesEmptyHint"));
    expect(page.query<HTMLButtonElement>("categories-empty-action")?.textContent).toBe(i18n.t("categoriesEmptyAction"));

    // the honest action puts the caret in the field the form already offers
    await act(async () => {
      page.query<HTMLButtonElement>("categories-empty-action")?.click();
    });
    const input = page.container.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("categoriesNewName")}"]`);
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("removes the empty state once the first category is created from the action", async () => {
    const page = await mount();

    // drive the whole flow the action starts: focus, type, submit
    await act(async () => {
      page.query<HTMLButtonElement>("categories-empty-action")?.click();
    });
    const input = page.container.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("categoriesNewName")}"]`)!;
    typeInto(input, "بطاريات");

    const form = page.container.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(created).toEqual([{ name: "بطاريات" }]);
    expect(categories).toEqual([{ id: "cat-1", name: "بطاريات" }]);
    await page.poll(() => page.container.textContent?.includes("بطاريات") === true, "created category shown");

    expect(page.query("categories-empty")).toBeNull();
    expect(page.container.textContent).toContain("بطاريات");
    expect(created).toEqual([{ name: "بطاريات" }]);
  });

  it("does not show the empty state once a category exists", async () => {
    categories = [{ id: "cat-1", name: "بطاريات" }];
    const page = await mount();

    expect(page.query("categories-empty")).toBeNull();
    expect(page.container.textContent).toContain("بطاريات");
  });
});
