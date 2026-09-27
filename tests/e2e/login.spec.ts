import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";

/**
 * Auth gate e2e: anonymous visitors never reach the app; the first-run setup
 * (or the login form once provisioned) signs the owner in, and the session
 * survives a reload (cookie persisted).
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
