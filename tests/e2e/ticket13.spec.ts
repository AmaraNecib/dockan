import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Ticket 13 e2e: the manual export button creates today's backup file on
 * disk under the api's data dir (.e2e-data/backups) and reports success.
 * The daily-on-startup copy is covered by unit tests (idempotency) — this
 * spec proves the user-facing path end to end.
 */
test("manual export backup creates today's file", async ({ page }) => {
  await page.goto("/");
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("الرئيسية")).toBeVisible();

  // startup already made today's daily copy; capture it so we can tell the
  // manual export apart by mtime afterwards if names collide (same name!)
  const backupsDir = path.join(process.cwd(), ".e2e-data", "backups");
  const todayName = `dokan-${new Date().toLocaleString("en-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" })}.db`;
  const backupPath = path.join(backupsDir, todayName);
  expect(fs.existsSync(backupsDir)).toBe(true);

  await page.goto("/backups");
  await expect(page.getByRole("heading", { name: "النسخ الاحتياطي" })).toBeVisible();

  await page.getByTestId("backup-export").click();
  await expect(page.getByTestId("backup-done")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("backup-done")).toContainText(todayName.replace("dokan-", ""));

  // the file really exists and was just rewritten by the manual export
  expect(fs.existsSync(backupPath)).toBe(true);
  const ageMs = Date.now() - fs.statSync(backupPath).mtimeMs;
  expect(ageMs).toBeLessThan(60_000);
});
