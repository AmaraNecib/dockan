import { expect, type Locator, type Page } from "@playwright/test";

/** Select an item from the themed Base UI Select popup by its visible label. */
export async function chooseSelectOption(page: Page, trigger: Locator, name: string): Promise<void> {
  await trigger.click();
  const option = page.getByRole("option", { name });
  await expect(option).toBeVisible();
  await option.click();
  // the popup closes once the selection is committed
  await expect(option).toBeHidden();
}

/** Open a themed Select and wait for a lazily loaded option to appear. */
export async function expectSelectOption(page: Page, trigger: Locator, name: string): Promise<void> {
  await trigger.click();
  await expect(page.getByRole("option", { name })).toBeVisible();
  await page.keyboard.press("Escape");
}
