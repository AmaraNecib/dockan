import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://127.0.0.1:5462";
const storage = process.argv[3];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ar-DZ", storageState: storage });
const page = await context.newPage();
await page.goto(`${BASE}/purchase`);
await page.getByTestId("purchase-form").waitFor();
await page.getByTestId("purchase-toggle-quick").click();
const info = await page.getByTestId("purchase-quick-form").evaluate((form) => {
  return Array.from(form.querySelectorAll("button, input, [role]")).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    type: el.getAttribute("type"),
    testid: el.getAttribute("data-testid"),
    name: el.getAttribute("name"),
    label: el.getAttribute("aria-label"),
    labelFor: el.getAttribute("id"),
    text: (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 40) ?? "",
  }));
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
