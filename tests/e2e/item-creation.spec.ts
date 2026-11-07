import { expect, test } from "@playwright/test";

test.use({ video: "on" });
import { signIn } from "./auth-helpers";
import { openItemsTab } from "./items-helpers";
import { chooseSelectOption } from "./select-helpers";
import { actAndAck, readRpc } from "./rpc-helpers";

type SavedItem = { id: string; name: string; categoryId: string; costPrice: number; sellingPrice: number; barcode: string | null; stockOnHand: number };

async function catalog(page: import("@playwright/test").Page) {
  return (await readRpc<{ items: SavedItem[] }>(page, "itemsAll")).items;
}

test("creation: explicit zeros persist, blank is refused, keyboard entry retains category #391", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const category = `إنشاء-${stamp}`;
  await signIn(page);
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(category);
  const savedCategory = await actAndAck<{ id: string }>(page, "categoriesCreate", () => page.getByRole("button", { name: "إضافة", exact: true }).click());
  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByTestId("item-form").getByRole("combobox"), category);

  // Blank cost is unresolved. It is not a request to save zero.
  await page.getByTestId("item-name").fill(`مجهول-${stamp}`);
  await page.getByTestId("item-cost").fill(" ");
  await page.getByTestId("item-sell").fill("10");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("item-cost")).toBeFocused();
  expect((await catalog(page)).filter((item) => item.name === `مجهول-${stamp}`)).toHaveLength(0);
  await expect(page.getByTestId("item-name")).toHaveValue(`مجهول-${stamp}`);

  for (const [index, cost, sell] of [[0, 0, 0], [1, 10, 0], [2, 0, 20]] as const) {
    const name = `متتابع-${stamp}-${index}`;
    await page.getByTestId("item-name").fill(name);
    await page.getByTestId("item-cost").fill(String(cost));
    await page.getByTestId("item-sell").fill(String(sell));
    if (index === 2) await page.getByTestId("initial-stock").fill("2");
    // Capture the same live form before and after its first persisted save.
    const form = page.getByTestId("item-form");
    if (index === 0) {
      await page.waitForTimeout(600);
      await form.screenshot({ path: testInfo.outputPath("item-form-before.png") });
    }
    // Enter on Save is the keyboard-only continuation path.
    await page.getByTestId("item-save").focus();
    await actAndAck(page, index === 2 ? "itemsCreateWithStock" : "itemsCreate", () => page.keyboard.press("Enter"));
    await expect(page.getByTestId("item-name")).toHaveValue("");
    await expect(page.getByTestId("item-name")).toBeFocused();
    await expect(page.getByTestId("item-cost")).toHaveValue("");
    await expect(page.getByTestId("item-sell")).toHaveValue("");
    await expect(page.getByTestId("item-barcode")).toHaveValue("");
    await expect(page.getByTestId("item-saved")).toContainText(name);
    await expect(form.getByRole("combobox")).toHaveValue(category);
    expect((await catalog(page)).find((item) => item.name === name)).toMatchObject({ costPrice: cost, sellingPrice: sell, categoryId: savedCategory.id, stockOnHand: index === 2 ? 2 : 0 });
    if (index === 0) {
      await page.waitForTimeout(600);
      await form.screenshot({ path: testInfo.outputPath("item-form-after.png") });
    }
  }

  // Read persisted values after a reload, not mutation arguments or component state.
  await page.reload();
  const zeroName = `متتابع-${stamp}-0`;
  const persistedZero = (await catalog(page)).find((item) => item.name === zeroName);
  if (persistedZero === undefined) throw new Error("zero-price item missing after reload");
  const row = page.locator("tr").filter({ has: page.getByRole("cell", { name: zeroName, exact: true }) });
  await row.getByTestId(`edit-item-${persistedZero.id}`).click();
  await expect(page.getByTestId("edit-cost")).toHaveValue("0");
  await expect(page.getByTestId("edit-sell")).toHaveValue("0");
});

test("creation: barcode Enter, delayed repeated submit, failed response and retry", async ({ page }) => {
  await signIn(page);
  await page.goto("/items");
  await openItemsTab(page, "add");
  const name = `تأخير-${Date.now()}`;
  const barcode = `391${Date.now()}`;
  let writes = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/rpc/itemsCreate", async (route) => {
    writes++;
    await gate;
    await route.continue();
  });
  await page.getByTestId("item-barcode").fill(barcode);
  await page.getByTestId("item-barcode").press("Enter");
  await expect(page.getByTestId("item-name")).toHaveValue("");
  expect(writes).toBe(0);
  await page.getByTestId("item-name").fill(name);
  await page.getByTestId("item-cost").fill("0");
  await page.getByTestId("item-sell").fill("0");
  await page.getByTestId("item-barcode").press("Enter");
  expect(writes).toBe(0);
  await page.getByTestId("item-save").click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByTestId("item-save")).toBeDisabled();
  await expect(page.getByTestId("item-name")).toHaveAttribute("readonly", "");
  await page.getByTestId("item-form").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await actAndAck(page, "itemsCreate", async () => { release?.(); });
  await expect(page.getByTestId("item-name")).toBeFocused();
  expect(writes).toBe(1);
  expect((await catalog(page)).filter((item) => item.name === name)).toHaveLength(1);
  await page.unroute("**/api/rpc/itemsCreate");

  const retryName = `${name}-إعادة`;
  await page.getByTestId("item-name").fill(retryName);
  await page.getByTestId("item-cost").fill("0");
  await page.getByTestId("item-sell").fill("0");
  await page.route("**/api/rpc/itemsCreate", (route) => route.abort("failed"));
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
  await expect(page.getByTestId("item-name")).toHaveValue(retryName);
  await expect(page.getByTestId("item-cost")).toHaveValue("0");
  expect((await catalog(page)).filter((item) => item.name === retryName)).toHaveLength(0);
  await page.unroute("**/api/rpc/itemsCreate");
  await actAndAck(page, "itemsCreate", () => page.getByTestId("item-save").click());
  await expect(page.getByTestId("item-name")).toBeFocused();
  expect((await catalog(page)).filter((item) => item.name === retryName)).toHaveLength(1);

  // A real server refusal maps the known offending barcode back to its input.
  await page.getByTestId("item-name").fill(`${name}-متعارض`);
  await page.getByTestId("item-cost").fill("0");
  await page.getByTestId("item-sell").fill("0");
  await page.getByTestId("item-barcode").fill(barcode);
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("form-error")).toContainText("هذا الباركود مستعمل");
  await expect(page.getByTestId("item-barcode")).toBeFocused();
  await expect(page.getByTestId("item-name")).toHaveValue(`${name}-متعارض`);
  expect((await catalog(page)).filter((item) => item.barcode === barcode)).toHaveLength(1);
});
