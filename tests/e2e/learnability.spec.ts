import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";

/**
 * Issue #94 — learnability. A fresh profile reads the nav in words, the empty
 * invoice names and offers the first step, and the finish action stays in the
 * viewport at the two short window heights the owner actually uses.
 */

async function seedCategory(page: import("@playwright/test").Page, categoryName: string): Promise<void> {
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();
}

/** Creates the item through the sale screen's quick-stock path and lands it as a line. */
async function addStockedLine(
  page: import("@playwright/test").Page,
  itemName: string,
  categoryName: string,
): Promise<void> {
  await page.getByTestId("sale-quick-stock-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await page.getByLabel("التصنيف").selectOption({ label: categoryName });
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
}

test("fresh profile: the nav reads in Arabic and survives collapsing", async ({ page }) => {
  await signIn(page);

  const nav = page.getByRole("navigation", { name: "التنقل الرئيسي" });
  // The daily workflow is named, not icon-only, on a fresh profile.
  for (const label of ["المبيعات", "المشتريات", "الفواتير", "الديون", "المرتجعات"]) {
    const link = nav.getByRole("link", { name: label });
    await expect(link).toBeVisible();
    await expect(link).toContainText(label);
  }

  // Collapsing keeps every link's accessible name even though the text is gone.
  const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
  await toggle.click();
  const salesLink = nav.getByRole("link", { name: "المبيعات" });
  await expect(salesLink).toBeVisible();
  await expect(salesLink).toHaveAttribute("aria-label", "المبيعات");
  await expect(salesLink).not.toContainText("المبيعات");

  // The choice is remembered: a reload keeps the collapsed, still-named nav.
  await page.reload();
  const reloadedNav = page.getByRole("navigation", { name: "التنقل الرئيسي" });
  const reloadedSales = reloadedNav.getByRole("link", { name: "المبيعات" });
  await expect(reloadedSales).toHaveAttribute("aria-label", "المبيعات");
  await expect(reloadedSales).not.toContainText("المبيعات");

  await page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" }).click();
  await expect(reloadedNav.getByRole("link", { name: "المبيعات" })).toContainText("المبيعات");
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
]) {
  test(`sale completes without scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);

    const stamp = Date.now().toString();
    const categoryName = `تعليم-تصنيف-${stamp}`;
    const itemName = `تعليم-منتج-${stamp}`;
    await seedCategory(page, categoryName);

    await page.goto("/sale");
    await expect(page.getByTestId("sale-form")).toBeVisible();

    // Empty invoice: it teaches the next step and offers it; checkout-only
    // controls (discount, finish) are not on screen yet.
    await expect(page.getByTestId("sale-empty")).toContainText("أضف أول منتج إلى الفاتورة");
    await expect(page.getByTestId("sale-empty").getByTestId("sale-open-picker")).toBeVisible();
    await expect(page.getByTestId("sale-discount-type")).toHaveCount(0);
    await expect(page.getByTestId("sale-save")).toHaveCount(0);

    await addStockedLine(page, itemName, categoryName);

    // With a line, the discount appears and the finish action is reachable
    // without the content container having scrolled at all.
    await expect(page.getByTestId("sale-discount-type")).toBeVisible();
    expect(await page.locator("main").evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByTestId("sale-save")).toBeInViewport({ ratio: 1 });
    await page.getByTestId("sale-save").click();
    await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  });
}

test("the checkout bar stays pinned while a long invoice scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `تثبيت-تصنيف-${stamp}`;
  await seedCategory(page, categoryName);
  await page.goto("/sale");
  for (let index = 0; index < 9; index += 1) {
    await addStockedLine(page, `تثبيت-منتج-${stamp}-${index}`, categoryName);
  }

  // Prove the page really overflows, then pin the bar mid-scroll: a bar in
  // normal flow would sit below the fold at this scroll offset.
  const metrics = await page.locator("main").evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  await page.locator("main").evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
  });
  await expect(page.getByTestId("sale-save")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("sale-total")).toBeInViewport({ ratio: 1 });
});
