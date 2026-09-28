import { expect, type Page } from "@playwright/test";

export type ItemsTab = "products" | "add";

const TAB_LABELS = {
  products: "المنتجات",
  add: "إضافة ومخزون",
} satisfies Record<ItemsTab, string>;

/** Switch the items page to a tab and wait for its panel to become visible. */
export async function openItemsTab(page: Page, tab: ItemsTab): Promise<void> {
  await page.getByRole("tab", { name: TAB_LABELS[tab], exact: true }).click();
  await expect(page.locator(`#items-panel-${tab}`)).toBeVisible();
}
