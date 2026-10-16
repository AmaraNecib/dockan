import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";

interface Category {
  id: string;
  name: string;
}

let categories: Category[] = [];
let created: Array<{ name: string }> = [];

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration and exposes every member the
// page touches, including queryKey — the create success path invalidates by it.
mock.module("@/lib/rpc", () => ({
  orpc: {
    categoriesList: {
      queryOptions: () => ({
        queryKey: ["categoriesList"],
        queryFn: async () => ({ items: categories }),
      }),
      queryKey: () => ["categoriesList"],
    },
    categoriesCreate: {
      mutationOptions: (options: { onSuccess?: () => void; onError?: (error: { message?: string }) => void }) => ({
        mutationKey: ["categoriesCreate"],
        ...options,
        mutationFn: async (input: { name: string }) => {
          created.push(input);
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
  document.body.innerHTML = "";
});

afterEach(async () => {
  await unmountAllMountedPages();
  document.body.innerHTML = "";
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
    await page.poll(() => page.query("categories-empty") === null, "empty state cleared");

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
