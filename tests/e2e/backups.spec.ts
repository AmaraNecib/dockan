import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { externalBackupDestinationInputSchema, type ExternalBackupStatus } from "../../packages/contracts/src/core";
import { z } from "zod";
import { callRpc, seedCategoryId } from "./rpc-helpers";
import fs from "node:fs";
import path from "node:path";

test.use({ video: { mode: "on", size: { width: 1920, height: 1080 } } });

/**
 * The manual export button creates today's backup file on
 * disk under the api's data dir (`E2E_DATA_DIR`, defaulting to
 * `.e2e-data/backups`) and reports success. The daily-on-startup copy is covered
 * by unit tests (idempotency) — this spec proves the user-facing path end to
 * end.
 */
test("manual export backup creates today's file", async ({ page }) => {
  await signIn(page);

  // Startup may already have made today's copy. Preserve its bytes so the
  // persisted marker below, not the filename or mtime, proves this export.
  const dataDir = process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data");
  const backupsDir = path.join(dataDir, "backups");
  const todayName = `dokan-${new Date().toLocaleString("en-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" })}.db`;
  const backupPath = path.join(backupsDir, todayName);
  expect(fs.existsSync(backupsDir)).toBe(true);
  const previousBackup = fs.existsSync(backupPath) ? fs.readFileSync(backupPath) : undefined;

  const categoryId = await seedCategoryId(page, "backup-export-e2e");
  const marker = `backup-export-marker-${process.pid}-${Date.now()}`;
  await callRpc(page, "itemsCreate", {
    name: marker,
    categoryId,
    costPrice: 17,
    sellingPrice: 29,
    lowStockThreshold: 0,
  });

  await page.goto("/backups");
  await expect(page.getByRole("heading", { name: "النسخ الاحتياطي" })).toBeVisible();

  await page.getByTestId("backup-export").click();
  await expect(page.getByTestId("backup-done")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("backup-done")).toContainText(todayName.replace("dokan-", ""));
  if (process.env.BACKUP_EVIDENCE === "before") {
    await page.locator("section").filter({ has: page.getByTestId("backup-export") }).screenshot({
      path: ".scratch/evidence/401/before.png",
    });
  }

  // the file really exists and was just rewritten by the manual export
  expect(fs.existsSync(backupPath)).toBe(true);
  const ageMs = Date.now() - fs.statSync(backupPath).mtimeMs;
  expect(ageMs).toBeLessThan(60_000);
  const exportedBackup = fs.readFileSync(backupPath);
  if (previousBackup !== undefined) {
    expect(previousBackup.includes(Buffer.from(marker))).toBe(false);
    expect(exportedBackup.equals(previousBackup)).toBe(false);
  }
  expect(exportedBackup.length).toBeGreaterThan(0);
  expect(exportedBackup.includes(Buffer.from(marker))).toBe(true);

  // The activity log stores the filesystem path for a backup, but the UI must
  // show its useful filename rather than the same eight-character ID preview
  // used for entity references.
  await page.goto("/activity");
  const backupRow = page.getByTestId("activity-table").locator("tbody tr").filter({ hasText: todayName });
  await expect(backupRow.first()).toBeVisible();
  await expect(backupRow.first().getByTestId("activity-ref")).toHaveText(todayName);
});

async function installRevealBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // SAFETY: this simulates the external IPC seam, not native Windows proof.
    const target = window as typeof window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: { path: string }) => Promise<void> };
      revealCalls: string[];
      revealFailure?: string;
    };
    target.revealCalls = [];
    target.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command !== "backup_reveal") throw new Error("not a vault broker");
        if (args) target.revealCalls.push(args.path);
        if (target.revealFailure) throw target.revealFailure;
      },
    };
  });
}

test("external backup destination persists, cancels edits, reports media failure, and retries", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await signIn(page);
  let externalStatus: ExternalBackupStatus = {
    destination: "D:/existing-backups",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastPath: null,
  };
  let failNextCopy = true;
  await page.route("**/api/rpc/externalBackupStatus", (route) => route.fulfill({ json: { json: externalStatus } }));
  await page.route("**/api/rpc/externalBackupDevice", (route) => route.fulfill({ json: { json: "same" } }));
  await page.route("**/api/rpc/externalBackupDestinationSet", async (route) => {
    const parsed = z.object({ json: externalBackupDestinationInputSchema }).safeParse(route.request().postDataJSON());
    if (!parsed.success) throw new Error("external destination route received invalid input");
    const destination = parsed.data.json.destination;
    externalStatus = {
      destination,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastPath: null,
    };
    await route.fulfill({ json: { json: externalStatus } });
  });
  await page.route("**/api/rpc/externalBackupRun", async (route) => {
    const destinationAtRun = externalStatus.destination;
    if (destinationAtRun === null) throw new Error("external backup ran without a saved destination");
    externalStatus = failNextCopy
      ? { ...externalStatus, lastAttemptAt: "2026-11-05T10:00:00", lastError: "disconnected" }
      : { ...externalStatus, lastAttemptAt: "2026-11-05T10:01:00", lastSuccessAt: "2026-11-05T10:01:00", lastError: null, lastPath: `${destinationAtRun}/dokan-backup-set/dokan-backup.dknvbak` };
    failNextCopy = false;
    await route.fulfill({ json: { json: externalStatus } });
  });

  await page.goto("/backups");
  const panel = page.getByTestId("external-backup-panel");
  await page.waitForTimeout(1800);
  const destination = page.getByTestId("external-backup-destination");
  await expect(destination).toHaveValue("D:/existing-backups");
  await destination.fill("E:/unsaved");
  await panel.getByRole("button", { name: "إلغاء التعديل" }).click();
  await expect(destination).toHaveValue("D:/existing-backups");
  await page.waitForTimeout(1800);

  await destination.fill("D:/shop-backups");
  await panel.getByRole("button", { name: "حفظ المجلد" }).click();
  await expect(destination).toHaveValue("D:/shop-backups");
  await expect(panel.getByRole("status")).toContainText("القرص الفعلي نفسه");
  await page.waitForTimeout(2200);
  if (process.env.BACKUP_EVIDENCE === "before" || process.env.BACKUP_EVIDENCE === "both") {
    await panel.screenshot({ path: ".scratch/evidence/403/before.png" });
  }

  await panel.getByRole("button", { name: "نسخ الآن" }).click();
  await expect(panel.getByRole("alert")).toContainText("القرص غير متصل");
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.waitForTimeout(2200);

  await panel.getByRole("button", { name: "نسخ الآن" }).click();
  await expect(page.getByTestId("external-backup-success")).toContainText("dokan-backup.dknvbak");
  await expect(page.getByTestId("external-backup-success").locator('[dir="ltr"]')).toContainText("D:/shop-backups/dokan-backup-set");
  await page.waitForTimeout(2200);
  failNextCopy = true;
  await panel.getByRole("button", { name: "نسخ الآن" }).click();
  await expect(panel.getByRole("alert")).toContainText("القرص غير متصل");
  await expect(page.getByTestId("external-backup-success").locator('[dir="ltr"]')).toContainText("D:/shop-backups/dokan-backup-set");
  await page.waitForTimeout(2200);
  await panel.getByRole("button", { name: "نسخ الآن" }).click();
  await expect(page.getByTestId("external-backup-success").locator('[dir="ltr"]')).toContainText("D:/shop-backups/dokan-backup-set");
  await page.waitForTimeout(2200);
  await page.reload();
  await expect(destination).toHaveValue("D:/shop-backups");
  await expect(page.getByTestId("external-backup-success").locator('[dir="ltr"]')).toContainText("D:/shop-backups/dokan-backup-set");
  await page.waitForTimeout(2200);
  if (process.env.BACKUP_EVIDENCE === "after" || process.env.BACKUP_EVIDENCE === "both") {
    await panel.screenshot({ path: ".scratch/evidence/403/after.png" });
  }
  await page.waitForTimeout(5200);
  await panel.getByRole("button", { name: "إزالة الوجهة" }).click();
  await expect(destination).toHaveValue("");
});

test.describe("completed backup reveal", () => {

  test("keyboard reveal uses the saved file and presents Arabic native failure and retry", async ({ page }) => {
    await installRevealBridge(page);
    await signIn(page);
    await page.goto("/backups");
    await expect(page.getByRole("button", { name: "إظهار الملف في المجلد" })).toHaveCount(0);
    await page.getByTestId("backup-export").focus();
    await page.keyboard.press("Enter");
    const done = page.getByTestId("backup-done");
    await expect(done).toBeVisible();
    const savedPath = await done.locator('[dir="ltr"]').innerText();
    expect(fs.existsSync(savedPath)).toBe(true);
    const reveal = page.getByRole("button", { name: "إظهار الملف في المجلد", exact: true });
    await page.keyboard.press("Tab");
    await expect(reveal).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() =>
      // SAFETY: read only this test's simulated IPC calls.
      (window as typeof window & { revealCalls: string[] }).revealCalls,
    )).toEqual([savedPath]);

    await page.evaluate(() => {
      // SAFETY: configure only this test's simulated native refusal.
      (window as typeof window & { revealFailure?: string }).revealFailure = "BACKUP_REVEAL_FAILED";
    });
    await reveal.press("Space");
    await expect(page.getByRole("alert")).toHaveText(
      "تعذّر إظهار الملف في المجلد. حاول مجدداً أو افتح المسار الظاهر يدوياً.",
    );
    await expect(done).toContainText(savedPath);
    if (process.env.BACKUP_EVIDENCE === "after") {
      await page.locator("section").filter({ has: page.getByTestId("backup-export") }).screenshot({
        path: ".scratch/evidence/401/after-failure.png",
      });
    }
    await page.evaluate(() => {
      // SAFETY: clear only this test's simulated native refusal.
      delete (window as typeof window & { revealFailure?: string }).revealFailure;
    });
    await reveal.press("Enter");
    await expect(page.getByRole("alert")).toHaveCount(0);
    if (process.env.BACKUP_EVIDENCE === "after") {
      await page.locator("section").filter({ has: page.getByTestId("backup-export") }).screenshot({
        path: ".scratch/evidence/401/after.png",
      });
    }

    await page.evaluate(() => {
      // SAFETY: configure only this test's simulated missing-file refusal.
      (window as typeof window & { revealFailure?: string }).revealFailure = "BACKUP_REVEAL_MISSING";
    });
    await reveal.press("Space");
    await expect(page.getByRole("alert")).toHaveText(
      "لم يعد ملف النسخة الاحتياطية موجوداً. أنشئ نسخة جديدة ثم حاول إظهارها.",
    );
    await expect(done).toHaveCount(0);
    await expect(reveal).toHaveCount(0);
    await expect(page.getByTestId("backup-export")).toBeFocused();
  });

  test("failed creation never exposes a completed backup or reveal action", async ({ page }) => {
    await installRevealBridge(page);
    await signIn(page);
    await page.goto("/backups");
    await page.getByTestId("backup-export").click();
    await expect(page.getByTestId("backup-done")).toBeVisible();
    await page.route("**/api/rpc/backupManual", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "UNEXPECTED" } }),
    }));
    await page.getByTestId("backup-export").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("backup-done")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إظهار الملف في المجلد" })).toHaveCount(0);
    await expect(page.getByTestId("backup-export")).toBeEnabled();
  });
});
