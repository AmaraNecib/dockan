import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://127.0.0.1:5462";
const storage = process.argv[3];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ar-DZ", storageState: storage });
const page = await context.newPage();
page.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 300)));
page.on("response", async (r) => {
  if (!r.url().includes("/api/")) return;
  const status = r.status();
  let body = "";
  try {
    body = (await r.text()).slice(0, 400);
  } catch {
    body = "(no body)";
  }
  console.log("resp:", status, r.request().method(), new URL(r.url()).pathname, body);
});
await page.goto(`${BASE}/purchase`);
await page.getByTestId("purchase-form").waitFor();
await page.getByTestId("purchase-toggle-quick").click();
await page.getByTestId("quick-name").fill("کرتون-بررسی");
await page.getByTestId("quick-qty").fill("2");
await page.getByTestId("quick-cost").fill("300");
console.log("quick values:", await page.getByTestId("quick-name").inputValue(), await page.getByTestId("quick-qty").inputValue(), await page.getByTestId("quick-cost").inputValue());
await page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }).click();
await page.waitForTimeout(4000);
console.log("url:", page.url());
console.log("form text:", (await page.getByTestId("purchase-form").innerText()).replace(/\s+/g, " ").slice(0, 1200));
await page.screenshot({ path: "D:/projects/mani-project/.scratch/evidence/pr-345/raw/probe-after.png", fullPage: true });
await browser.close();
