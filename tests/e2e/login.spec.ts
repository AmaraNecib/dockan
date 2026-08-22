import { expect, test } from "@playwright/test";

/**
 * Ticket 02 e2e: anonymous visitors see the login screen; first-time setup
 * via the build secret creates the admin; the same credentials sign in and
 * the session survives a reload (cookie persisted).
 */
test("first-time setup, login, and persisted session", async ({ page }) => {
  // 1. anonymous → login screen, no data
  await page.goto("/");
  await expect(page.getByTestId("login-submit")).toBeVisible();

  // 2. first-time setup with the build secret
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");

  // 3. the form pre-fills the phone and signs in
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("تم تسجيل الدخول بنجاح")).toBeVisible();

  // 4. session persists across a reload (cookie)
  await page.reload();
  await expect(page.getByText("تم تسجيل الدخول بنجاح")).toBeVisible();
});