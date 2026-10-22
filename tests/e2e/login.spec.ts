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

/**
 * Signing out reloads the page on the plaintext build too (#319 round 4).
 *
 * This suite runs with `DOKAN_VAULT=disabled`, so `/api/vault/logout` is not
 * mounted and the revoke answers 404. Reading that as "the revoke failed" held
 * the page instead of reloading — the only build in which the no-vault answer
 * is the COMMON case, and the app stayed mounted after a sign-out the server had
 * already accepted.
 *
 * What is asserted is the reload, because only a fresh document can prove the
 * page did not merely unmount a subtree. The browser session itself does not
 * die here: better-auth's origin check refuses the sign-out POST behind the vite
 * proxy (`Invalid origin: http://127.0.0.1:5173` — its baseURL is the api's own
 * origin), so the session cookie survives and the reloaded page can sign back
 * in. That refusal predates this change and is not what this case is about.
 */
test("signing out on the plaintext build reloads the page", async ({ page }) => {
  await signIn(page);
  // a value only a fresh document can forget
  await page.evaluate(() => {
    // SAFETY: a probe property this test sets on the page's own window
    (window as { signedOutReloadProbe?: number }).signedOutReloadProbe = 1;
  });

  await page.getByRole("button", { name: "خروج" }).click();
  // the dialog's confirm button, not the header icon that opened it (same name)
  await page.getByRole("dialog").getByRole("button", { name: "خروج" }).click();

  await expect
    .poll(
      // SAFETY: the same probe, read back from whatever document is on screen now
      async () => await page.evaluate(() => (window as { signedOutReloadProbe?: number }).signedOutReloadProbe),
      { timeout: 10_000 },
    )
    .toBeUndefined();
});

/**
 * #347 — a sign-out through the dev proxy must actually end the session.
 *
 * better-auth compares the request's `Origin` against `baseURL`, but only when
 * the request carries a cookie (`dist/api/middlewares/origin-check.mjs`:
 * `if (!(forceValidate || useCookies)) return`). That is exactly why sign-IN
 * worked through the proxy and sign-OUT did not: by sign-out the browser holds
 * the session cookie, so the check engages and compares the dev server's origin
 * against the API's own port:
 *
 *     POST /api/auth/sign-out -> 403 Invalid origin: http://127.0.0.1:5173
 *
 * The assertion is that the SESSION IS DEAD, not that a page navigated: any
 * endpoint that 404s would satisfy the latter. `get-session` answers `null` for a
 * dead session and the owner object for a live one, both with 200.
 *
 * `page.request` is the Node-side client bound to this page's cookie jar: it can
 * set `Origin` (a browser cannot — the header is forbidden), which is what makes
 * both halves testable at all.
 */
test("a sign-out through the dev proxy ends the session", async ({ page }) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;

  const liveBefore = await page.request.get("/api/auth/get-session");
  expect(liveBefore.status()).toBe(200);
  expect(await liveBefore.text()).toContain(OWNER_PHONE.replace(/^213/, ""));

  // the same request shape the app sends, with the page's own origin
  const signedOut = await page.request.post("/api/auth/sign-out", {
    headers: { origin, "content-type": "application/json" },
  });
  expect(signedOut.status()).toBe(200);

  const deadAfter = await page.request.get("/api/auth/get-session");
  expect(deadAfter.status()).toBe(200);
  expect((await deadAfter.text()).trim()).toBe("null");
});

/**
 * ...and the negative: an origin outside the list is still refused WITH the
 * cookie present. A fix that turned `trustedOrigins` into a blanket allow would
 * pass every other case in this file.
 */
test("a foreign origin is refused with the session cookie present", async ({ page }) => {
  await signIn(page);
  const refused = await page.request.post("/api/auth/sign-out", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
  });
  expect(refused.status()).toBe(403);

  // ...and the refusal was about the ORIGIN, not about the request being
  // rejected for some other reason: the session is still live afterwards
  const stillLive = await page.request.get("/api/auth/get-session");
  expect(stillLive.status()).toBe(200);
  expect(await stillLive.text()).toContain(OWNER_PHONE.replace(/^213/, ""));
});
