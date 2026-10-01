import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { expectSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * Catalog search ranking, USB-wedge scan capture at window
 * level (fast burst + Enter), duplicate protection, and the unknown-scan
 * dialog that never creates data without an explicit choice.
 */
test("catalog search, wedge scanning, and the unknown-scan path", async ({ page }) => {
  // 0. sign in (the session guard is part of the seam)
  await signIn(page);

  // 1. seed: a category + two items, one carrying a barcode
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("زيوت");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("زيوت", { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  // the form needs the category list loaded before it can submit
  await expectSelectOption(page, page.getByLabel("التصنيف"), "زيوت");

  await page.getByTestId("item-name").fill("زيت محرك 5W30");
  await page.getByLabel("سعر الشراء (دج)").fill("900");
  await page.getByLabel("سعر البيع (دج)").fill("1400");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /زيت محرك/ })).toBeVisible();

  await openItemsTab(page, "add");
  await page.getByTestId("item-name").fill("بطارية");
  await page.getByTestId("item-barcode").fill("6210001000017");
  await page.getByLabel("سعر الشراء (دج)").fill("1200");
  await page.getByLabel("سعر البيع (دج)").fill("1900");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
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

  // 2b. the manual picker keeps the active row on the combobox and selects it
  // through Enter, exercising the user-facing keyboard seam in a real browser.
  await page.getByTestId("open-picker").click();
  const picker = page.getByTestId("picker-dialog");
  await expect(picker).toBeVisible();
  const pickerInput = picker.getByRole("combobox", { name: "ابحث بالاسم أو الباركود…" });
  await pickerInput.fill("زيت");
  const pickerOptions = picker.getByRole("option");
  await expect(pickerOptions).toHaveCount(1);
  await pickerInput.press("ArrowDown");
  await expect(pickerInput).toHaveAttribute("aria-activedescendant", /picker-option-/);
  await expect(pickerOptions.first()).toHaveAttribute("aria-selected", "true");
  await pickerInput.press("Enter");
  await expect(picker).toBeHidden();

  // scans below happen with no field focused — the deterministic wedge path
  await page.getByTestId("catalog-search").blur();

  // 3. wedge scan with focus OUTSIDE any input: fast burst + Enter. RPC-call
  //    counting makes suppression provable (oRPC multiplexes every procedure
  //    through one /api/rpc endpoint; the name rides in the POST body).
  let searchCalls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/rpc/catalogSearch")) searchCalls++;
  });

  await page.keyboard.type("6210001000017", { delay: 12 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scan-found")).toContainText("بطارية");

  await page.keyboard.type("UNKNOWN-999", { delay: 12 });
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("unknown-scan-dialog");
  await expect(dialog).toBeVisible();
  // both lookups must have hit the wire
  await expect.poll(() => searchCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  const callsBeforeDuplicate = searchCalls;

  // 4. true duplicate suppression: rescanning the SAME code inside the
  //    duplicate window (~150 ms of typing vs a 1200 ms window) must be
  //    swallowed — no second catalogSearch RPC, no state change.
  await page.keyboard.type("UNKNOWN-999", { delay: 12 });
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
  await page.keyboard.type("UNKNOWN-777", { delay: 12 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create").click();
  await expect(page.getByTestId("item-barcode")).toHaveValue("UNKNOWN-777");
  await page.getByTestId("item-name").fill("منتج ممسوح");
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("160");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /منتج ممسوح/ })).toBeVisible();
  // rescanning now finds it instead of opening the dialog — past the e2e
  // duplicate window (1200 ms) plus margin
  await page.waitForTimeout(1500);
  await page.keyboard.type("UNKNOWN-777", { delay: 12 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scan-found")).toContainText("منتج ممسوح");

  // 6. create-with-stock path lands stock on hand > 0 — and must not create
  //    without its opening quantity (the scan choice promises a movement)
  await page.keyboard.type("UNKNOWN-555", { delay: 12 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  await page.getByTestId("item-name").fill("منتج بمخزون");
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("300");

  // blank and 0 are refused by name; an unreadable value keeps its own message
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("form-error")).toContainText("أدخل كمية مخزون أكبر من صفر");
  await page.getByTestId("initial-stock").fill("0");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("form-error")).toContainText("أدخل كمية مخزون أكبر من صفر");
  await page.getByTestId("initial-stock").fill("-1");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("form-error")).toContainText("أدخل مخزوناً افتتاحياً صحيحاً");
  await expect(page.getByTestId("form-error")).not.toContainText("أدخل كمية مخزون أكبر من صفر");

  // and the positive quantity still creates in one step
  await page.getByTestId("initial-stock").fill("7");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /منتج بمخزون/ })).toContainText("7");
});

test("stale scan lookups never overwrite newer results", async ({ page }) => {
  // sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // seed a known item with a barcode so one scan resolves exactly
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("زينة");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("زينة", { exact: true })).toBeVisible();
  await page.goto("/items");
  await openItemsTab(page, "add");
  await expectSelectOption(page, page.getByLabel("التصنيف"), "زينة");
  await page.getByTestId("item-name").fill("نظارة مرايا");
  await page.getByTestId("item-barcode").fill("9990000000011");
  await page.getByLabel("سعر الشراء (دج)").fill("150");
  await page.getByLabel("سعر البيع (دج)").fill("250");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /نظارة مرايا/ })).toBeVisible();
  // scans below happen with no field focused — the deterministic wedge path
  await page.getByTestId("catalog-search").fill("");
  await page.getByTestId("catalog-search").blur();

  // hold ONLY the first scan's response so the second scan settles first.
  // If stale settlements could write state, the slow UNKNOWN scan settling
  // after the fast KNOWN scan would open the dialog with the wrong code.
  let catalogCalls = 0;
  await page.route("**/api/rpc/catalogSearch", async (route) => {
    catalogCalls++;
    if (catalogCalls === 1) await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await page.keyboard.type("UNKNOWN-RACE", { delay: 12 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("9990000000011", { delay: 12 });
  await page.keyboard.press("Enter");

  // the fast KNOWN scan's success notice must win immediately…
  await expect(page.getByTestId("scan-found")).toContainText("نظارة مرايا");
  // …and the stale UNKNOWN settling later must NOT open the dialog
  await page.waitForTimeout(900); // let the delayed lookup settle
  await expect(page.getByTestId("unknown-scan-dialog")).toBeHidden();
  await expect(page.getByTestId("scan-found")).toContainText("نظارة مرايا");
});

test("scan while focus is inside an input commits through the editable regime", async ({ page }) => {
  // sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // seed a known item with its own barcode so the test is order-independent
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("عدد");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("عدد", { exact: true })).toBeVisible();
  await page.goto("/items");
  await openItemsTab(page, "add");
  await expectSelectOption(page, page.getByLabel("التصنيف"), "عدد");
  await page.getByTestId("item-name").fill("مفتاح فلتر");
  await page.getByTestId("item-barcode").fill("8880000000019");
  await page.getByLabel("سعر الشراء (دج)").fill("300");
  await page.getByLabel("سعر البيع (دج)").fill("500");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /مفتاح فلتر/ })).toBeVisible();

  // focus stays INSIDE an editable field: a tight burst is still a scan, and
  // the keys also feed the field (both regimes must hold at once)
  const search = page.getByTestId("catalog-search");
  // await focus: an un-awaited focus() races the first keystroke and drops it
  await search.focus();
  await page.keyboard.type("8880000000019", { delay: 12 });
  await page.keyboard.press("Enter");

  // the wedge path recognized the burst…
  await expect(page.getByTestId("scan-found")).toContainText("مفتاح فلتر");
  // …while the keystrokes still reached the focused field
  await expect(search).toHaveValue(/8880000000019/);
});
