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

  // the copy names both fields, so the summary is a live region and takes focus
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // the e2e server shares one database; if better-auth's rate limiter is ever
  // enabled the same attempt answers with the lockout copy — both name the
  // problem, and the retired generic copy may never appear
  const copy = await alert.innerText();
  expect([
    "رقم الهاتف أو كلمة السر غير صحيحة. تحقّق منهما ثم أعد المحاولة.",
    "محاولات كثيرة خلال وقت قصير. انتظر قليلاً ثم أعد المحاولة.",
  ]).toContain(copy);
  await expect(alert).toBeFocused();
});

test("a malformed phone names the phone, not the password", async ({ page }) => {
  await provisionOwner(page);

  await page.getByLabel("رقم الهاتف").fill("12345");
  await page.getByLabel("كلمة السر").fill(OWNER_PASSWORD);
  await page.getByTestId("login-submit").click();

  // a field error is announced through the field's description, not a second
  // live region (issue #113)
  const alert = page.locator("#login-error");
  // the phone runs are wrapped in LTR isolates so the sign cannot be displaced
  await expect(alert).toHaveText("رقم الهاتف غير صالح. اكتبه بالصيغة الجزائرية مثل \u20660550123123\u2069 أو \u2066+213550123123\u2069.");
  // checked after the text attaches, so the negated matcher cannot pass while
  // the paragraph is still detached
  await expect(alert).not.toHaveAttribute("role", "alert");
  // the phone is the field to fix, so focus lands there
  await expect(page.getByLabel("رقم الهاتف")).toBeFocused();
});

test("an empty login field shows Arabic copy, never the browser bubble", async ({ page }) => {
  await provisionOwner(page);

  // the browser would normally pop its own locale bubble on these fields; the
  // form opts out and the app owns every message
  await expect(page.locator("form")).toHaveAttribute("novalidate", "");

  await page.getByTestId("login-submit").click();
  const alert = page.locator("#login-error");
  await expect(alert).toHaveText("رقم الهاتف غير صالح. اكتبه بالصيغة الجزائرية مثل \u20660550123123\u2069 أو \u2066+213550123123\u2069.");
  // after the text attaches, so the negated matcher is meaningful
  await expect(alert).not.toHaveAttribute("role", "alert");
  await expect(page.getByLabel("رقم الهاتف")).toBeFocused();
  // the native rule still holds (required → valueMissing), but noValidate means
  // the browser never gets to render its bubble
  expect(
    await page.getByLabel("رقم الهاتف").evaluate((el) => {
      // SAFETY: the locator resolves to the required <input name="username">
      return (el as HTMLInputElement).validity.valueMissing;
    }),
  ).toBe(true);

  await page.getByLabel("رقم الهاتف").fill(OWNER_PHONE);
  await page.getByTestId("login-submit").click();
  await expect(alert).toHaveText("كلمة السر قصيرة جداً. استعمل 4 أحرف على الأقل.");
  await expect(page.getByLabel("كلمة السر")).toBeFocused();
});
