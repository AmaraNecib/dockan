import { expect, test } from "@playwright/test";

/**
 * Ticket 28 e2e: catalog search ranking, USB-wedge scan capture at window
 * level (fast burst + Enter), duplicate protection, and the unknown-scan
 * dialog that never creates data without an explicit choice.
 */
test("catalog search, wedge scanning, and the unknown-scan path", async ({ page }) => {
  // 0. first-time setup + sign in (the session guard is part of the seam)
  await page.goto("/");
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("الرئيسية")).toBeVisible();

  // 1. seed: a category + two items, one carrying a barcode
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("زيوت");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("زيوت", { exact: true })).toBeVisible();

  await page.goto("/items");
  // the form needs the category list loaded before it can submit
  const categoryOption = page.getByRole("combobox").locator("option", { hasText: "زيوت" });
  await expect(categoryOption).toHaveCount(1);

  await page.getByTestId("item-name").fill("زيت محرك 5W30");
  await page.getByLabel("سعر الشراء (دج)").fill("900");
  await page.getByLabel("سعر البيع (دج)").fill("1400");
  await page.getByTestId("item-save").click();
  await expect(page.getByRole("row", { name: /زيت محرك/ })).toBeVisible();

  await page.getByTestId("item-name").fill("بطارية");
  await page.getByTestId("item-barcode").fill("6210001000017");
  await page.getByLabel("سعر الشراء (دج)").fill("1200");
  await page.getByLabel("سعر البيع (دج)").fill("1900");
  await page.getByTestId("item-save").click();
  await expect(page.getByRole("row", { name: /بطارية/ })).toBeVisible();

  // 2. typed search ranks results; exact barcode shows the single hit
  const search = page.getByTestId("catalog-search");
  await search.fill("6210001000017");
  await expect(page.getByTestId("search-results")).toContainText("بطارية");

  await search.fill("زيت");
  await expect(page.getByTestId("search-results")).toContainText("زيت محرك 5W30");

  await search.fill("كلمة-غير-موجودة");
  await expect(page.getByTestId("search-results")).toContainText("لا توجد نتائج مطابقة");
  await search.fill("");
  // scans below happen with no field focused — the deterministic wedge path
  await page.getByTestId("catalog-search").blur();

  // 3. wedge scan with focus OUTSIDE any input: fast burst + Enter. RPC-call
  //    counting makes suppression provable (oRPC multiplexes every procedure
  //    through one /api/rpc endpoint; the name rides in the POST body).
  let searchCalls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/rpc/catalogSearch")) searchCalls++;
  });

  await page.keyboard.type("6210001000017", { delay: 4 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scan-found")).toContainText("بطارية");

  await page.keyboard.type("UNKNOWN-999", { delay: 4 });
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("unknown-scan-dialog");
  await expect(dialog).toBeVisible();
  // both lookups must have hit the wire
  await expect.poll(() => searchCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  const callsBeforeDuplicate = searchCalls;

  // 4. true duplicate suppression: rescanning the SAME code inside the
  //    duplicate window (~150 ms of typing vs a 1200 ms window) must be
  //    swallowed — no second catalogSearch RPC, no state change.
  await page.keyboard.type("UNKNOWN-999", { delay: 4 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400); // settle past any in-flight work
  expect(searchCalls).toBe(callsBeforeDuplicate); // suppressed, not re-sent
  await expect(dialog).toBeVisible();

  const rowsWithUnknownCode = page.getByRole("row", { name: /UNKNOWN-999/ });
  await expect(rowsWithUnknownCode).toHaveCount(0);
  await page.getByTestId("scan-cancel").click();
  await expect(dialog).toBeHidden();
  await expect(rowsWithUnknownCode).toHaveCount(0);

  // 5. unknown scan -> create item prefilled with the scanned barcode
  await page.keyboard.type("UNKNOWN-777", { delay: 4 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create").click();
  await expect(page.getByTestId("item-barcode")).toHaveValue("UNKNOWN-777");
  await page.getByTestId("item-name").fill("منتج ممسوح");
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("160");
  await page.getByTestId("item-save").click();
  await expect(page.getByRole("row", { name: /منتج ممسوح/ })).toBeVisible();
  // rescanning now finds it instead of opening the dialog — past the e2e
  // duplicate window (1200 ms) plus margin
  await page.waitForTimeout(1500);
  await page.keyboard.type("UNKNOWN-777", { delay: 4 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scan-found")).toContainText("منتج ممسوح");

  // 6. create-with-stock path lands stock on hand > 0
  await page.keyboard.type("UNKNOWN-555", { delay: 4 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  await page.getByTestId("item-name").fill("منتج بمخزون");
  await page.getByTestId("initial-stock").fill("7");
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("300");
  await page.getByTestId("item-save").click();
  await expect(page.getByRole("row", { name: /منتج بمخزون/ })).toContainText("7");
});
