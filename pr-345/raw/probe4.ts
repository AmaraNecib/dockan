import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://127.0.0.1:5461";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ar-DZ", storageState: "raw/storage-before.json" });
const page = await context.newPage();
for (const p of ["/customers", "/purchase"]) {
  await page.goto(`${BASE}${p}`);
  await page.waitForTimeout(2500);
  const out = await page.evaluate(() => {
    const lines = document.querySelector('[data-testid="purchase-lines"]');
    const firstRow = lines?.querySelector("tbody tr") ?? null;
    const note = document.querySelector('input[name="notes"]');
    return {
      hasLines: lines !== null,
      hasFirstRow: firstRow !== null,
      noteTag: note === null ? null : note.tagName,
      noteValue: note === null ? null : (note as HTMLInputElement).value,
      testids: Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")).slice(0, 40),
    };
  });
  console.log(p, JSON.stringify(out));
}
await browser.close();
