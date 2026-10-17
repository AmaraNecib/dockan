import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { readRpc, saveQuickAdd } from "./rpc-helpers";

/**
 * #257 — create the product on the purchase line the owner is already editing.
 *
 * The shortcut only earns its place if the line keeps the quantity and unit cost
 * he typed, so this drives exactly that: a line with typed values, a product
 * created from the line, the line re-pointed at it with those values intact, and
 * the purchase landing as the new product's initial stock.
 */
test("purchase line: create the product inline, keep the typed line, stock it by the invoice", async ({ page }) => {
  await signIn(page);

  // the shared e2e database is wiped per run, but names still carry a stamp so a
  // rerun against a live slot cannot collide with its own leftovers
  const stamp = Date.now().toString();
  const categoryName = `قطع-${stamp}`;
  const temporaryName = `وسيط-${stamp}`;
  const productName = `مضخة-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // 1. a purchase line to create FROM (the page-level quick-add is the existing
  //    path that puts a row on the invoice)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(`مورد-${stamp}`);
  // the party picker's suggestion menu is an absolute overlay that reaches down
  // into the lines card; Escape is the picker's own close control (it stays open
  // on a click it would intercept)
  await page.keyboard.press("Escape");
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(temporaryName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByTestId("quick-qty").fill("1");
  await page.getByTestId("quick-cost").fill("100");
  const temporary = await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }),
    error: page.getByTestId("purchase-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName: temporaryName,
    quantityLabel: "الكمية",
  });

  // 2. the owner types the real quantity and unit cost on that line
  const lineQty = page.getByTestId("purchase-lines").getByLabel(`${temporaryName}: الكمية`);
  const lineCost = page.getByTestId("purchase-lines").getByLabel(`${temporaryName}: تكلفة الوحدة (دج)`);
  await lineQty.fill("3");
  await lineCost.fill("900");
  await expect(lineQty).toHaveValue("3");
  await expect(page.getByTestId("purchase-total")).toContainText("2700");

  // 3. «منتج جديد» on the line opens the inline form right there
  await page.getByTestId("purchase-lines").getByRole("button", { name: `منتج جديد: ${temporaryName}` }).click();
  const lineForm = page.getByTestId("purchase-line-product-form");
  await expect(lineForm).toBeVisible();
  // the form states the cost it will record, so the price is not a mystery
  await expect(page.getByTestId("line-product-cost")).toContainText("900");
  await page.getByTestId("line-product-name").fill(productName);
  await chooseSelectOption(page, lineForm.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("line-product-sell").fill("1400");

  // 4. the create is a real write: wait for the server to accept it and for the
  //    line to be keyed on the id the server issued
  const created = await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("line-product-save"),
    error: page.getByTestId("line-product-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName: productName,
    quantityLabel: "الكمية",
  });
  expect(created.id).not.toBe(temporary.id);

  // 5. the line kept what the owner typed, and the total recomputed
  const createdQty = page.getByTestId("purchase-lines").getByLabel(`${productName}: الكمية`);
  await expect(createdQty).toHaveValue("3");
  await expect(page.getByTestId("purchase-lines").getByLabel(`${productName}: تكلفة الوحدة (دج)`)).toHaveValue("900");
  await expect(page.getByTestId("purchase-total")).toContainText("2700");
  // the create form closed and the caret is on the line's quantity
  await expect(page.getByTestId("purchase-line-product-form")).toHaveCount(0);
  await expect(createdQty).toBeFocused();

  // 6. saving the invoice books the purchase, so the new product carries the
  //    quantity as its initial stock — no separate stock write anywhere
  await page.getByTestId("purchase-save").click();
  // #268 gave every kind its own number prefix (a purchase is SUP-NNNN, not
  // INV-), so assert the purchase's own shape — the digits included, or a
  // prefix-less number would still pass the assertion.
  await expect(page.getByTestId("purchase-saved-number")).toContainText(/SUP-\d+/);

  const catalog = await readRpc<{ items: Array<{ id: string; name: string; costPrice: number; sellingPrice: number; stockOnHand: number; categoryName: string | null }> }>(page, "itemsAll");
  const row = catalog.items.find((item) => item.id === created.id);
  expect(row).toBeDefined();
  expect({ name: row?.name, categoryName: row?.categoryName, costPrice: row?.costPrice, sellingPrice: row?.sellingPrice, stockOnHand: row?.stockOnHand }).toEqual({
    name: productName,
    categoryName,
    costPrice: 900,
    sellingPrice: 1400,
    stockOnHand: 3,
  });

  // …and it is in the catalogue the owner browses, not only in the API. The row
  // name carries a digit stamp, so a bare substring match on "3"/"1400" could
  // pass on the name alone; assert the cells themselves.
  await page.goto("/items");
  const itemsRow = page.getByRole("row", { name: new RegExp(productName) });
  await expect(itemsRow).toBeVisible();
  await expect(itemsRow.getByRole("cell", { name: "1400 دج", exact: true })).toBeVisible();
  await expect(itemsRow.getByTestId("stock-after-cell")).toHaveText(/^3\b/);
});

/**
 * #257 review round 1 (F2/F6) — a line whose unit cost is still zero. The ticket
 * says the owner may be "about to" type the cost, so the create must not be
 * blocked on it; and the cost the product then carries is not frozen, because
 * the invoice line's own stock movement replays the ledger average at save time.
 */
test("purchase line: a create from a zero-cost line is allowed and the invoice prices the product", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `قطع-${stamp}`;
  const temporaryName = `وسيط-${stamp}`;
  const productName = `مضخة-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(temporaryName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByTestId("quick-qty").fill("3");
  await page.getByTestId("quick-cost").fill("100");
  await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }),
    error: page.getByTestId("purchase-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName: temporaryName,
    quantityLabel: "الكمية",
  });

  // the owner has not typed the purchase price yet: a cleared cost field is 0
  const lineCost = page.getByTestId("purchase-lines").getByLabel(`${temporaryName}: تكلفة الوحدة (دج)`);
  await lineCost.fill("");
  await expect(lineCost).toHaveValue("0");

  await page.getByTestId("purchase-lines").getByRole("button", { name: `منتج جديد: ${temporaryName}` }).click();
  await page.getByTestId("line-product-name").fill(productName);
  await chooseSelectOption(page, page.getByTestId("purchase-line-product-form").getByLabel("التصنيف"), categoryName);
  await page.getByTestId("line-product-sell").fill("1400");
  const created = await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("line-product-save"),
    error: page.getByTestId("line-product-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName: productName,
    quantityLabel: "الكمية",
  });

  // the product exists at the line's current cost (0) — the shortcut was not
  // blocked on a price the owner is about to type
  const atCreate = await readRpc<{ items: Array<{ id: string; costPrice: number }> }>(page, "itemsAll");
  expect(atCreate.items.find((item) => item.id === created.id)?.costPrice).toBe(0);

  // now he types the price on the line (which the create re-pointed at the new
  // product, so its fields are labelled with the new name), and saving the
  // invoice prices the product
  const createdCost = page.getByTestId("purchase-lines").getByLabel(`${productName}: تكلفة الوحدة (دج)`);
  await createdCost.fill("900");
  await expect(page.getByTestId("purchase-total")).toContainText("2700");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText(/SUP-\d+/);

  const afterSave = await readRpc<{ items: Array<{ id: string; costPrice: number; sellingPrice: number; stockOnHand: number }> }>(page, "itemsAll");
  expect(afterSave.items.find((item) => item.id === created.id)).toMatchObject({
    costPrice: 900,
    sellingPrice: 1400,
    stockOnHand: 3,
  });
});

/**
 * #257 review round 4 (F1) — the ordering fix at user level.
 *
 * `submit()` maps the lines into the request body, so from that moment the draft
 * it serialised must not change: a replacement after it went out leaves the
 * invoice stocking the old product, the new one off it. That window is one local
 * round-trip — tens of milliseconds — so the response is held open with
 * `page.route`; a state a screenshot can otherwise miss is the point of the
 * test, and the delay is the only way to observe it without faking the client.
 *
 * The screenshots land in `test-results/` (gitignored, so an e2e run never dirties
 * the tree) and the lane copies the pair into `.scratch/reviews/257/screenshots/`
 * under the reviewed SHA. Running this spec against the pre-fix tree is the
 * round-4 e2e red: the frozen status never appears and the controls stay live.
 */
test("purchase line: the invoice draft is frozen while the save is in flight (#257 round 4)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `قطع-${stamp}`;
  const productName = `وسيط-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // a purchase line to save (the page-level quick-add is the existing path)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(`مورد-${stamp}`);
  // the party picker's suggestion overlay reaches into the lines card; Escape is
  // the picker's own close control
  await page.keyboard.press("Escape");
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(productName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByTestId("quick-qty").fill("2");
  await page.getByTestId("quick-cost").fill("900");
  const created = await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }),
    error: page.getByTestId("purchase-error"),
    lines: page.getByTestId("purchase-lines"),
    itemName: productName,
    quantityLabel: "الكمية",
  });

  const lines = page.getByTestId("purchase-lines");
  const lineTrigger = lines.getByRole("button", { name: `منتج جديد: ${productName}` });
  const linePick = page.getByTestId(`purchase-line-pick-${created.id}`);
  const lineQty = lines.getByLabel(`${productName}: الكمية`);
  const lineCost = lines.getByLabel(`${productName}: تكلفة الوحدة (دج)`);
  // before the save every one of these is live, so the freeze below is a change
  // and not the page's resting state
  await expect(lineTrigger).toBeEnabled();
  await expect(linePick).toBeEnabled();
  await expect(lineQty).toBeEnabled();
  await expect(lineCost).toBeEnabled();
  await page.screenshot({ path: "test-results/round4-evidence/draft-live-before-save.png" });

  // hold the invoice write open: the frozen state exists only while it is out.
  // 2500 ms, not 4000: the window has to stay well inside Playwright's 5000 ms
  // expect timeout, or a slow round trip turns the screenshots into flakes.
  await page.route("**/api/rpc/invoicesCreate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.getByTestId("purchase-save").click();
  // the save itself is pending in both trees; the screenshot is taken here so the
  // pre-fix run records the live controls this test is about
  await expect(page.getByTestId("purchase-save")).toBeDisabled();
  await page.screenshot({ path: "test-results/round4-evidence/draft-during-save.png" });

  // the request is out, so the draft it serialised is read-only — and the frozen
  // table states why, because a disabled control with no stated reason is a dead
  // end for a keyboard or screen-reader user
  await expect(page.getByTestId("purchase-lines-frozen")).toBeVisible();
  await expect(lineTrigger).toBeDisabled();
  await expect(linePick).toBeDisabled();
  await expect(lineQty).toBeDisabled();
  await expect(lineCost).toBeDisabled();

  // and the save that lands books the product the owner chose, at the quantity
  // and cost the frozen controls were showing
  await expect(page.getByTestId("purchase-saved-number")).toContainText(/SUP-\d+/);
  const catalog = await readRpc<{ items: Array<{ id: string; name: string; stockOnHand: number; costPrice: number }> }>(page, "itemsAll");
  expect(catalog.items.find((item) => item.id === created.id)).toMatchObject({ name: productName, stockOnHand: 2, costPrice: 900 });
});
