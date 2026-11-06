// Opt-in driver for desktop::restore_webview_tests. Real WebView2, native
// picker, registered IPC and the compiled sidecar; disposable fixtures only.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { z } from "zod";

const fixtureFile = process.argv[2];
if (!fixtureFile) throw new Error("native fixture manifest required");
const fixture = z.object({ root: z.string(), origin: z.string().url(), cdpPort: z.number(), pid: z.number() }).parse(JSON.parse(fs.readFileSync(fixtureFile, "utf8")));
const evidence = path.dirname(fixtureFile);
const fixtureCredential = "native fixture passphrase";
const incomingCredential = "incoming native fixture passphrase";
const chosen = path.join(fixture.root, "selected.dknvbak");
const selectedBefore = createHash("sha256").update(fs.readFileSync(chosen)).digest("hex");
const corrupt = Buffer.from(fs.readFileSync(chosen));
corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
fs.writeFileSync(path.join(fixture.root, "corrupt.dknvbak"), corrupt);
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${out} ${err}`);
  return out;
}
const deadline = Date.now() + 30_000;
let browser;
while (!browser && Date.now() < deadline) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${fixture.cdpPort}`); }
  catch { await Bun.sleep(250); }
}
if (!browser) throw new Error("WebView2 did not expose its fixture CDP endpoint");
const context = browser.contexts()[0];
if (!context) throw new Error("native browser context missing");
const page = context.pages()[0];
if (!page) throw new Error("native main window missing");
page.setDefaultTimeout(25_000);
const session = `402-native-${fixture.pid}`;
const agent = (...args: string[]) => command(["agent-browser", "--session", session, "--cdp", String(fixture.cdpPort), ...args]);
let recording = false;
try {
  await expect(page.getByTestId("vault-passphrase")).toBeVisible();
  await page.getByTestId("vault-passphrase").fill(fixtureCredential);
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("vault-passphrase")).not.toBeVisible();
  await page.goto(`${fixture.origin}/backups`);
  const backupSection = page.getByRole("heading", { name: "النسخ الاحتياطي", exact: true }).locator("..");
  if (process.env.DOKAN_NATIVE_RESTORE_BEFORE) {
    await expect(page.getByTestId("backup-export")).toBeVisible();
    await backupSection.screenshot({ path: path.join(evidence, "backups-before.png") });
    await browser.close();
    console.log("PASS incumbent backup-page element capture from pinned pre-integration source");
    process.exit(0);
  }
  const panel = page.getByTestId("backup-restore");
  await expect(panel.getByRole("button", { name: "اختيار نسخة للاستعادة", exact: true })).toBeEnabled();
  await panel.screenshot({ path: path.join(evidence, "restore-after-idle.png") });
  await backupSection.screenshot({ path: path.join(evidence, "backups-after.png") });
  async function pick(file?: string) {
    const helper = command(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "apps/desktop/tests/restore-picker.ps1", "-AppProcessId", String(fixture.pid), ...(file ? ["-SelectedPath", path.join(fixture.root, file)] : ["-Cancel"])]);
    await panel.getByRole("button", { name: "اختيار نسخة للاستعادة", exact: true }).click();
    try { await helper; }
    catch (error) {
      await panel.screenshot({ path: path.join(evidence, "restore-picker-failure.png") });
      console.error("Picker renderer state:", await panel.innerText());
      throw error;
    }
  }
  async function inspect(secret = incomingCredential) {
    await panel.locator("#restore-backup-secret").fill(secret);
    await panel.getByRole("button", { name: "فحص النسخة", exact: true }).click();
  }
  async function cancel() { await panel.getByRole("button", { name: "إلغاء الاستعادة", exact: true }).click(); }
  async function confirm(secret = fixtureCredential) {
    await panel.locator("#restore-current-secret").fill(secret);
    await panel.locator("#restore-confirm").check();
    await panel.getByRole("button", { name: "استبدال بيانات المتجر", exact: true }).click();
  }
  await pick();
  await expect(panel.locator("#restore-backup-secret")).toHaveCount(0);
  console.log("PASS real native picker cancellation");
  await pick("selected.dknvbak");
  await inspect("wrong fixture credential");
  await expect(panel.getByRole("alert")).toContainText("تحقّق");
  await inspect();
  await expect(panel.getByTestId("restore-preview")).toBeVisible();
  await expect(panel).toContainText("آخر تعديل للملف");
  await expect(panel).toContainText("ستُحدّث");
  await panel.screenshot({ path: path.join(evidence, "restore-after-preview.png") });
  await cancel();
  await expect(panel.locator("#restore-current-secret")).toHaveCount(0);
  console.log("PASS authenticated older-schema preview and confirmation cancellation");
  for (const [file, refusal] of [["newer.dknvbak", "إصدار أحدث"], ["corrupt.dknvbak", "تحقّق"]]) {
    if (!file || !refusal) throw new Error("fixture refusal missing");
    await pick(file); await inspect();
    await expect(panel.getByRole("alert")).toContainText(refusal);
    await cancel();
  }
  console.log("PASS newer schema and corrupt encrypted container refusals");
  await pick("broken.dknvbak"); await inspect();
  await expect(panel.getByTestId("restore-preview")).toBeVisible();
  await confirm("wrong current fixture");
  await expect(panel.getByRole("alert")).toContainText("المتجر الحالي");
  console.log("PASS wrong current credential refused before shutdown");
  await confirm();
  await expect(page.getByTestId("vault-passphrase")).toBeVisible();
  await expect(page.getByTestId("restore-outcome")).toContainText("لم تكتمل الاستعادة");
  await page.getByTestId("restore-outcome").screenshot({ path: path.join(evidence, "restore-after-rollback.png") });
  await page.getByTestId("vault-passphrase").fill(fixtureCredential);
  await page.getByTestId("vault-unlock-submit").click();
  await page.goto(`${fixture.origin}/categories`);
  await expect(page.getByText("Original native record", { exact: true })).toBeVisible();
  console.log("PASS actual post-install migration failure, locked restart and original saved records");
  await page.goto(`${fixture.origin}/backups`);
  await agent("record", "start", path.join(evidence, "restore-native.webm"), "--cursor"); recording = true;
  await pick("selected.dknvbak"); await Bun.sleep(800);
  await inspect();
  await expect(panel.getByTestId("restore-preview")).toBeVisible();
  await Bun.sleep(2000);
  await confirm();
  await expect(page.getByTestId("vault-passphrase")).toBeVisible();
  await expect(page.getByTestId("restore-outcome")).toContainText("اكتملت الاستعادة");
  await page.getByTestId("restore-outcome").screenshot({ path: path.join(evidence, "restore-after-locked.png") });
  const safetyPath = await page.getByTestId("restore-outcome").locator("bdi").innerText();
  const safety = JSON.parse(await command(["bun", "apps/api/src/test-support/native-restore-fixture.ts", fixture.root, "safety", safetyPath]));
  expect(safety.names).toContain("Original native record");
  await Bun.sleep(2000);
  await page.getByTestId("vault-passphrase").fill(incomingCredential);
  await page.getByTestId("vault-unlock-submit").click();
  await page.goto(`${fixture.origin}/categories`);
  await expect(page.getByText("Restored native record", { exact: true })).toBeVisible();
  await expect(page.getByText("Original native record", { exact: true })).toHaveCount(0);
  await Bun.sleep(2000);
  await agent("record", "stop"); recording = false;
  expect(createHash("sha256").update(fs.readFileSync(chosen)).digest("hex")).toBe(selectedBefore);
  fs.writeFileSync(path.join(evidence, "native-results.json"), JSON.stringify({ realWebview: true, realPicker: true, realRegisteredIpc: true, realCompiledSidecar: true, savedRecord: "Restored native record", independentSafetyRecord: "Original native record", selectedSha256: selectedBefore, safetyPath }, null, 2));
  console.log("PASS real registered wrapper restore, fresh locked gate, incoming unlock, persisted records and independent encrypted safety reopen");
} finally {
  if (recording) await agent("record", "stop").catch(() => {});
  // Disconnect the observer; the fixture owns and closes the native process.
  await browser.close();
}
