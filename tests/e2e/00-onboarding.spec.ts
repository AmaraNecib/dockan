import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

/**
 * Issue #97 — getting-started checklist. The suite shares one database that is
 * wiped only once at webServer boot, so the fresh-install assertions must run
 * before any other spec creates records. `workers: 1` plus Playwright's
 * alphabetical file order puts this file first; the numeric prefix makes that
 * explicit and keeps a later rename from silently breaking the fresh state.
 */

const stamp = Date.now().toString();
const categoryName = `بداية-تصنيف-${stamp}`;
const itemName = `بداية-منتج-${stamp}`;
const customerName = `بداية-زبون-${stamp}`;

test.describe.configure({ mode: "serial" });

/**
 * Own the fresh-install state instead of borrowing the boot wipe: Playwright
 * runs `beforeAll` once per --repeat-each group, so resetting the shop records
 * here makes the assertion honest under repetition. Auth, store settings and
 * number sequences survive; only shop records and UI preferences are cleared.
 */
test.beforeAll(() => {
  runReset("reset-e2e-records.mjs");
});

/**
 * Preferences are server-side now, so one test's dismissal/completion would
 * leak into the next. Each test starts from a clean preference row.
 */
test.beforeEach(() => {
  runReset("reset-e2e-preferences.mjs");
});

function runReset(script: string): void {
  execFileSync("bun", [`scripts/${script}`], {
    cwd: process.cwd(),
    // respect a harness-supplied data dir; only default when none is set
    env: { ...process.env, E2E_DATA_DIR: process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data") },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

test("fresh install: the panel lists the four steps in shop order", async ({ page }) => {
  await signIn(page);

  const panel = page.getByTestId("getting-started");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "خطواتك الأولى" })).toBeVisible();

  const steps = panel.getByTestId("getting-started-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("أضف منتجاتك");
  await expect(steps.nth(1)).toContainText("سجّل مشترياتك");
  await expect(steps.nth(2)).toContainText("اعمل أول عملية بيع");
  await expect(steps.nth(3)).toContainText("تابع ديونك");

  for (let index = 0; index < 4; index += 1) {
    await expect(steps.nth(index)).toHaveAttribute("data-state", "pending");
  }

  // real links to each screen, not div-onClick
  await expect(steps.nth(0).getByRole("link")).toHaveAttribute("href", "/items");
  await expect(steps.nth(1).getByRole("link")).toHaveAttribute("href", "/purchase");
  await expect(steps.nth(2).getByRole("link")).toHaveAttribute("href", "/sale");
  await expect(steps.nth(3).getByRole("link")).toHaveAttribute("href", "/debts");
});

test("the loading placeholder matches the checklist footprint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });

  // Hold only the checklist read so the skeleton can be measured; auth, the
  // summary, and the preferences read all proceed normally.
  let releaseProgress = () => {};
  const heldProgress = new Promise<void>((resolve) => {
    releaseProgress = resolve;
  });
  await page.route("**/api/rpc/onboardingProgress", async (route) => {
    await heldProgress;
    await route.continue();
  });

  await signIn(page);
  const skeleton = page.getByTestId("getting-started-skeleton");
  await expect(skeleton).toBeVisible();
  const skeletonHeight = await skeleton.evaluate((element) => element.getBoundingClientRect().height);

  releaseProgress();
  const panel = page.getByTestId("getting-started");
  await expect(panel).toBeVisible();
  const panelHeight = await panel.evaluate((element) => element.getBoundingClientRect().height);

  // same footprint: the dashboard must not jump when the real data arrives
  expect(Math.abs(skeletonHeight - panelHeight)).toBeLessThanOrEqual(1);
  await page.unroute("**/api/rpc/onboardingProgress");
});

test("creating an item completes step 1 without a reload", async ({ page }) => {
  await signIn(page);
  const steps = page.getByTestId("getting-started-step");
  await expect(steps.nth(0)).toHaveAttribute("data-state", "pending");

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("item-save").click();
  await expect(page.getByRole("row", { name: new RegExp(itemName) })).toBeVisible();

  // Back to the dashboard through the app. The DOM marker on <html> survives
  // only if the navigation stayed client-side — a full reload would wipe it.
  await page.evaluate(() => document.documentElement.setAttribute("data-no-reload-marker", "1"));
  await page.getByRole("link", { name: "الرئيسية" }).click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-no-reload-marker"))).toBe("1");

  await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
  await expect(steps.nth(1)).toHaveAttribute("data-state", "pending");
});

test("dismissing the panel survives a reload", async ({ page }) => {
  await signIn(page);
  const panel = page.getByTestId("getting-started");
  await expect(panel).toBeVisible();

  await page.getByTestId("getting-started-dismiss").click();
  await expect(panel).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
});

test("completing every step removes the panel", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("getting-started")).toBeVisible();

  // Purchase: stock the item created in the previous test.
  await page.goto("/purchase");
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-open-picker").click();
  const purchasePicker = page.getByTestId("picker-dialog");
  await purchasePicker.getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await purchasePicker.getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");

  // Sale with a named customer and a partial payment: a real debt exists.
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(customerName);
  await page.getByTestId("sale-open-picker").click();
  const salePicker = page.getByTestId("picker-dialog");
  await salePicker.getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await salePicker.getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("2");
  await page.getByTestId("sale-paid").fill("500");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const invoiceNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  await page.goto("/");
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);

  // Settle the debt this spec created: later specs' debts-screen totals assume
  // they own the only outstanding balance. The onboarding state is already
  // proven above; paying it off leaves the shared database clean.
  await page.goto("/invoices");
  await page.getByTestId(`invoice-open-${invoiceNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await page.getByTestId("pmt-amount").fill("1500");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("pmt-done")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toContainText("0");
});
