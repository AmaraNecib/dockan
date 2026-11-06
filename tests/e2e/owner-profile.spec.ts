import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck, readRpc } from "./rpc-helpers";

test.use({ video: "on" });

// These journeys share the operator's persisted preference with later specs.
test.afterEach(async ({ page }) => {
  const sidebar = page.locator("aside");
  if (await sidebar.isVisible()) {
    const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
    await expect(toggle).toBeEnabled();
    if (await sidebar.evaluate((element) => element.getBoundingClientRect().width) === 64) {
      await actAndAck(page, "preferencesSet", () => toggle.click());
    }
    await expect.poll(async () => (await readRpc<{ values: Record<string, string> }>(page, "preferencesGet")).values["ui.sidebar.collapsed"] ?? "false").toBe("false");
    await page.reload();
    await expect(toggle).toBeEnabled();
    await expect(sidebar).toHaveCSS("width", "240px");
  }
});

test("verified owner stays in the sidebar in expanded and collapsed RTL states; header has one logout", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const sidebar = page.locator("aside");
  const identity = page.getByTestId("sidebar-owner-identity");
  const header = page.locator("header");
  await expect(identity).toContainText("مالك الاختبار");
  await expect(identity).toContainText("المالك");
  await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  await expect(header).not.toContainText("مالك الاختبار");
  await expect(header.getByRole("button", { name: "خروج" })).toHaveCount(1);
  if (process.env.OWNER_EVIDENCE_DIR) {
    await identity.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/expanded-identity.png` });
    await header.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/expanded-header.png` });
  }

  const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
  await toggle.click();
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(identity).toHaveAttribute("aria-label", /مالك الاختبار.*المالك.*توسيع الشريط الجانبي/);
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(identity).toHaveAttribute("aria-label", /مالك الاختبار.*المالك.*توسيع الشريط الجانبي/);
  if (process.env.OWNER_EVIDENCE_DIR) {
    await identity.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/collapsed-identity.png` });
    await header.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/collapsed-header.png` });
  }

  await header.getByRole("button", { name: "خروج" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "إغلاق" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(identity).toHaveAttribute("aria-label", /مالك الاختبار/);
});

test("long mixed owner names stay within a narrow RTL sidebar; unavailable identity never invents a role", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const name = "عبد الرحمن Amara بن محمد صاحب المتجر ذو الاسم الطويل جداً";
  await page.route("**/api/rpc/currentOwner", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.json.name = name;
    await route.fulfill({ response, json: payload });
  });
  await page.reload();
  const identity = page.getByTestId("sidebar-owner-identity");
  await expect(identity).toContainText(name);
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator("aside");
  const toggle = page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" });
  await toggle.click();
  await expect(sidebar).toHaveCSS("width", "64px");
  const box = await identity.boundingBox();
  if (!box) throw new Error("collapsed owner identity has no layout box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(identity).toHaveAttribute("aria-label", /Amara.*المالك.*توسيع الشريط الجانبي/);
  if (process.env.OWNER_EVIDENCE_DIR) await identity.screenshot({ path: `${process.env.OWNER_EVIDENCE_DIR}/narrow-collapsed-identity.png` });

  await toggle.click();
  await expect(sidebar).toHaveCSS("width", "240px");
  await expect(identity).toContainText("المالك");
  const expandedBox = await identity.boundingBox();
  if (!expandedBox) throw new Error("expanded owner identity has no layout box");
  expect(expandedBox.x).toBeGreaterThanOrEqual(0);
  expect(expandedBox.x + expandedBox.width).toBeLessThanOrEqual(390);

  await page.unroute("**/api/rpc/currentOwner");
  await page.route("**/api/rpc/currentOwner", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("button", { name: "تعذّر تحميل الحساب. أعد المحاولة." })).toBeVisible();
  await expect(page.getByTestId("sidebar-owner-identity")).toHaveCount(0);
  await page.unroute("**/api/rpc/currentOwner");
  await page.getByRole("button", { name: "تعذّر تحميل الحساب. أعد المحاولة." }).click();
  await expect(page.getByTestId("sidebar-owner-identity")).toContainText("مالك الاختبار");
});
