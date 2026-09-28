import { expect, test } from "@playwright/test";
import { OWNER_PASSWORD, OWNER_PHONE, provisionOwner, signIn } from "./auth-helpers";

/**
 * Auth gate e2e: anonymous visitors never reach the app; the first-run setup
 * (or the login form once provisioned) signs the owner in, and the session
 * survives a reload (cookie persisted). The failure cases pin issue #100: a
 * mistyped phone or password must name the problem, not read as a crash.
 */
test("auth gate, sign-in, and persisted session", async ({ page }) => {
  // 1. anonymous → the auth gate, never the app
  await page.goto("/");
  await expect(page.getByTestId("dashboard-page")).toHaveCount(0);
  await expect(
    page
      .getByRole("heading", { name: "تسجيل الدخول" })
      .or(page.getByRole("heading", { name: "مرحباً بك في دكان" })),
  ).toBeVisible();

  // 2. setup (clean room) or login (provisioned) reaches the dashboard
  await signIn(page);

  // 3. session persists across a reload (cookie)
  await page.reload();
  await expect(page.getByRole("heading", { name: "الرئيسية" })).toBeVisible();
});

test("a wrong password names the problem instead of the generic failure", async ({ page }) => {
  await provisionOwner(page);

  await page.getByLabel("رقم الهاتف").fill(OWNER_PHONE);
  await page.getByLabel("كلمة السر").fill("definitely-not-the-password");
  await page.getByTestId("login-submit").click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText("رقم الهاتف أو كلمة السر غير صحيحة. تحقّق منهما ثم أعد المحاولة.");
  await expect(alert).not.toContainText("حدث خطأ غير متوقع");
  // the alert names the problem; focus lands on the password so it can be retyped
  await expect(page.getByLabel("كلمة السر")).toBeFocused();
});

test("a malformed phone names the phone, not the password", async ({ page }) => {
  await provisionOwner(page);

  await page.getByLabel("رقم الهاتف").fill("12345");
  await page.getByLabel("كلمة السر").fill(OWNER_PASSWORD);
  await page.getByTestId("login-submit").click();

  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("رقم الهاتف غير صالح. اكتبه بالصيغة الجزائرية مثل 0550123123 أو +213550123123.");
  await expect(alert).not.toContainText("حدث خطأ غير متوقع");
  // the phone is the field to fix, so focus lands there
  await expect(page.getByLabel("رقم الهاتف")).toBeFocused();
});
