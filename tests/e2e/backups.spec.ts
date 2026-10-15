import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import fs from "node:fs";
import path from "node:path";

/**
 * The manual export button creates today's backup file on
 * disk under the api's data dir (`E2E_DATA_DIR`, defaulting to
 * `.e2e-data/backups`) and reports success. The daily-on-startup copy is covered
 * by unit tests (idempotency) — this spec proves the user-facing path end to
 * end.
 */
test("manual export backup creates today's file", async ({ page }) => {
  await signIn(page);

  // startup already made today's daily copy; capture it so we can tell the
  // manual export apart by mtime afterwards if names collide (same name!)
  const dataDir = process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data");
  const backupsDir = path.join(dataDir, "backups");
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

  // The activity log stores the filesystem path for a backup, but the UI must
  // show its useful filename rather than the same eight-character ID preview
  // used for entity references.
  await page.goto("/activity");
  const backupRow = page.getByTestId("activity-table").locator("tbody tr").filter({ hasText: todayName });
  await expect(backupRow.first()).toBeVisible();
  await expect(backupRow.first().getByTestId("activity-ref")).toHaveText(todayName);
});
