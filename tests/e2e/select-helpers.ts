import { expect, type Locator, type Page } from "@playwright/test";

/** Select a visible option from either the themed Select or a searchable entity picker. */
export async function chooseSelectOption(page: Page, trigger: Locator, name: string): Promise<void> {
  const isCombobox = await trigger.getAttribute("role") === "combobox";
  if (isCombobox) {
    await trigger.fill(name);
  } else {
    await trigger.click();
  }
  const option = page.getByRole("option", { name, exact: true });
  await expect(option).toBeVisible();
  await option.click();
  if (isCombobox) await expect(trigger).toHaveValue(name);
  else await expect(option).toBeHidden();
}

/** Open a selector and wait for a lazily loaded option to appear. */
export async function expectSelectOption(page: Page, trigger: Locator, name: string): Promise<void> {
  const isCombobox = await trigger.getAttribute("role") === "combobox";
  if (isCombobox) await trigger.fill(name);
  else await trigger.click();
  await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}
