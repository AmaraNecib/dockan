import { expect, type Page } from "@playwright/test";

/**
 * Shared e2e auth preamble. The specs share one wiped-at-boot database and run
 * sequentially: the first spec on a clean room meets the first-run setup form,
 * every later spec meets the login form. Both paths end on the app.
 */

const OWNER_NAME = "مالك الاختبار";
const STORE_NAME = "متجر الاختبار";
const PHONE = "0550123123";
const PASSWORD = "pass-1234";
const SECRET = "e2e-secret-0123456789";

interface SignInOptions {
  /** Route where the auth gate should appear; defaults to the dashboard. */
  startPath?: string;
  /** Test id of the post-login screen; defaults to the dashboard page. */
  landingTestId?: string;
}

export async function signIn(page: Page, options: SignInOptions = {}): Promise<void> {
  await page.goto(options.startPath ?? "/");

  const setupHeading = page.getByRole("heading", { name: "مرحباً بك في دكان" });
  const loginHeading = page.getByRole("heading", { name: "تسجيل الدخول" });
  await expect(setupHeading.or(loginHeading)).toBeVisible();
  const onSetup = await setupHeading.isVisible();
  const onLogin = await loginHeading.isVisible();
  // exactly one gate: neither screen is a valid state, and guessing wrong here
  // would fail later at a confusing locator
  expect(onSetup !== onLogin).toBe(true);

  if (onSetup) {
    await page.getByLabel("اسم المالك").fill(OWNER_NAME);
    await page.getByLabel("اسم المتجر").fill(STORE_NAME);
    await page.getByLabel("رقم الهاتف").fill(PHONE);
    await page.getByLabel("كلمة السر").fill(PASSWORD);
    await page.getByTestId("setup-secret").fill(SECRET);
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    // setup succeeds into the login form
    await expect(loginHeading).toBeVisible();
  }

  await page.getByLabel("رقم الهاتف").fill(PHONE);
  await page.getByLabel("كلمة السر").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId(options.landingTestId ?? "dashboard-page")).toBeVisible();
}

/**
 * The rare back-office cluster starts folded. Specs that navigate by link name
 * to a page inside it open the group first instead of depending on collapse
 * state.
 */
export async function openSystemNav(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "النظام" });
  await expect(toggle).toBeVisible();
  const expanded = await toggle.getAttribute("aria-expanded");
  // a missing attribute means the toggle is not the control this helper thinks
  // it is; fail here instead of silently leaving the cluster closed
  expect(expanded).not.toBeNull();
  if (expanded === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}
