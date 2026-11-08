import { expect, type Locator, type Page } from "@playwright/test";

export function saleLineRow(lines: Locator, itemName: string): Locator {
  return lines.getByRole("row").filter({ hasText: itemName });
}

export async function selectRadioValue(group: Locator, value: "AMOUNT" | "PERCENTAGE"): Promise<void> {
  const radio = group.locator(`input[type="radio"][value="${value}"]`);
  await expect(radio).toBeVisible();
  await radio.locator("xpath=..").click();
}

export async function chooseDiscountMode(page: Page, mode: "AMOUNT" | "PERCENTAGE"): Promise<void> {
  await selectRadioValue(page.getByTestId("sale-discount-type"), mode);
}

export async function expectDiscountControlsCollapsed(page: Page): Promise<void> {
  await expect(page.getByTestId("sale-add-discount")).toBeVisible();
  await expect(page.getByTestId("sale-discount-type")).toHaveCount(0);
  await expect(page.getByTestId("sale-discount-value")).toHaveCount(0);
}

export async function openDiscountControls(page: Page): Promise<void> {
  const group = page.getByTestId("sale-discount-type");
  if (!(await group.isVisible())) await page.getByTestId("sale-add-discount").click();
  await expect(group).toBeVisible();
  await expect(page.getByTestId("sale-discount-value")).toBeVisible();
}
