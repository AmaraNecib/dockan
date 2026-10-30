import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck, readRpc } from "./rpc-helpers";

// These journeys share the operator's persisted preference with later specs.
test.afterEach(async ({ page }) => {
  const sidebar = page.locator("aside");
  if (await sidebar.isVisible()) {
    const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
    await expect(toggle).toBeEnabled();
    if (await sidebar.evaluate((element) => element.getBoundingClientRect().width) === 64) {
      await actAndAck(page, "preferencesSet", () => toggle.click());
    }
    await expect.poll(async () => (await readRpc<{ values: Record<string, string> }>(page, "preferencesGet")).values["ui.sidebar.collapsed"]).toBe("false");
    await page.reload();
    await expect(toggle).toBeEnabled();
    await expect(sidebar).toHaveCSS("width", "240px");
  }
});

test("verified owner stays visible collapsed, with keyboard account menu and persisted sidebar choice", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const header = page.locator("header");
  const account = page.getByTestId("account-menu-trigger");
  await expect(account).toContainText("مالك الاختبار");
  if (process.env.OWNER_EVIDENCE_DIR) await header.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/expanded.png` });
  await expect(account).toContainText("المالك");
  await expect(header).not.toContainText("+213550123123");
  const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
  await toggle.click();
  await expect(page.locator("aside")).toHaveCSS("width", "64px");
  await expect(account).toBeVisible();
  await expect(account).toContainText("مالك الاختبار");
  await page.reload();
  await expect(page.locator("aside")).toHaveCSS("width", "64px");
  await expect(account).toContainText("المالك");
  await account.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu")).toContainText("+213550123123");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(account).toBeFocused();
  await account.click();
  await page.getByRole("menuitem", { name: "خروج" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "إغلاق" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(account).toContainText("مالك الاختبار");
  if (process.env.OWNER_EVIDENCE_DIR) await header.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/collapsed.png` });
  await toggle.click();
  await expect(page.locator("aside")).toHaveCSS("width", "240px");
  await expect(account).toContainText("المالك");
});

test("long mixed owner names fit a narrow RTL header and unavailable identity never invents a role", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  // Only this layout case replaces display text. Credential authority is
  // exercised by the real-session journey above and API refusal tests.
  const name = "عبد الرحمن Amara بن محمد صاحب المتجر ذو الاسم الطويل جداً";
  await page.route("**/api/rpc/currentOwner", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.json.name = name;
    await route.fulfill({ response, json: payload });
  });
  await page.reload();
  const account = page.getByTestId("account-menu-trigger");
  await expect(account).toContainText(name);
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
  await toggle.click();
  await expect(page.locator("aside")).toHaveCSS("width", "64px");
  const box = await account.boundingBox();
  if (!box) throw new Error("account trigger has no layout box");
  expect(box.width).toBeGreaterThan(70);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  if (process.env.OWNER_EVIDENCE_DIR) await page.locator("header").screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/narrow.png` });
  await account.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toContainText(name);
  if (process.env.OWNER_EVIDENCE_DIR) await page.getByRole("menu").screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/narrow-menu.png` });
  await expect(page.getByTestId("account-phone")).toHaveAttribute("dir", "ltr");
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  await page.unroute("**/api/rpc/currentOwner");
  await page.route("**/api/rpc/currentOwner", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("button", { name: "تعذّر تحميل الحساب. أعد المحاولة." })).toBeVisible();
  await expect(account).toHaveCount(0);
  await expect(page.locator("header")).not.toContainText(name);
  await expect(page.locator("header")).not.toContainText("المالك");
  await page.unroute("**/api/rpc/currentOwner");
  await page.getByRole("button", { name: "تعذّر تحميل الحساب. أعد المحاولة." }).click();
  await expect(account).toContainText("مالك الاختبار");
});
