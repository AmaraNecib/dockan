import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { saveQuickAdd } from "./rpc-helpers";

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
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
}

/** Creates a catalogue item so the purchase picker has something to offer. */
async function seedItem(
  page: import("@playwright/test").Page,
  itemName: string,
  categoryName: string,
): Promise<void> {
  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: new RegExp(itemName) })).toBeVisible();
}

/** Adds one line to the purchase through the catalog picker. */
async function addPickedLine(page: import("@playwright/test").Page, itemName: string): Promise<void> {
  await page.getByTestId("purchase-open-picker").click();
  // the picker only queries once a term exists, so the search is not optional
  const picker = page.getByTestId("picker-dialog");
  await picker.getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await picker.getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);
}

/**
 * Creates a distinct item through the purchase quick-add and lands it as a line.
 * Lines are keyed by item id, so re-adding one item replaces its row instead of
 * growing the page — a long purchase needs a fresh item per line.
 */
async function addQuickStockLine(
  page: import("@playwright/test").Page,
  itemName: string,
  categoryName: string,
): Promise<void> {
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("quick-qty").fill("2");
  await page.getByTestId("quick-cost").fill("400");
  // the purchase quick-add has no with-stock path: it always calls itemsCreate
  await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }),
    error: page.getByTestId("purchase-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);
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

    // The focus clearance must track the bar's real height, not a fixed guess:
    // a debt notice or a save error makes the bar taller, and a stale clearance
    // would leave a keyboard-focused control hidden behind it.
    const barMetrics = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="sale-checkout-bar"]');
      if (bar === null) return null;
      return {
        rendered: bar.offsetHeight,
        published: getComputedStyle(document.documentElement).getPropertyValue("--checkout-bar-height").trim(),
      };
    });
    expect(barMetrics?.rendered).toBeGreaterThan(0);
    expect(barMetrics?.published).toBe(`${barMetrics?.rendered}px`);

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

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
]) {
  test(`purchase completes without scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);

    const stamp = Date.now().toString();
    const categoryName = `شراء-تصنيف-${stamp}`;
    const itemName = `شراء-منتج-${stamp}`;
    await seedCategory(page, categoryName);
    await seedItem(page, itemName, categoryName);

    await page.goto("/purchase");
    await expect(page.getByTestId("purchase-form")).toBeVisible();

    // Empty purchase: it teaches the next step and offers it; the total and the
    // save action are not on screen until there is something to save.
    await expect(page.getByTestId("purchase-empty")).toBeVisible();
    await expect(page.getByTestId("purchase-open-picker")).toBeVisible();
    await expect(page.getByTestId("purchase-save")).toHaveCount(0);

    await page.getByTestId("purchase-supplier").fill(`مورد-${stamp}`);
    await addPickedLine(page, itemName);

    // With a line, the total and the finish action are reachable without the
    // content container having scrolled at all.
    expect(await page.locator("main").evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByTestId("purchase-total")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("purchase-save")).toBeInViewport({ ratio: 1 });
  });
}

test("the purchase bar stays pinned while a long purchase scrolls", async ({ page }) => {
  // each line costs a picker round-trip, and the loop below keeps adding until
  // the page genuinely overflows
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `تثبيت-شراء-${stamp}`;
  const itemName = `تثبيت-شراء-منتج-${stamp}`;
  await seedCategory(page, categoryName);
  await seedItem(page, itemName, categoryName);

  await page.goto("/purchase");
  // Each line needs its own item: lines are keyed by item id, so re-adding one
  // item replaces its row rather than growing the page.
  for (let index = 0; index < 9; index += 1) {
    await addQuickStockLine(page, `تثبيت-شراء-${stamp}-${index}`, categoryName);
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
  await expect(page.getByTestId("purchase-save")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("purchase-total")).toBeInViewport({ ratio: 1 });
});
