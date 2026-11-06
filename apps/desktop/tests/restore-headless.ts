// Headless renderer proof only. Native picker/IPC are test adapters, not
// packaged desktop evidence. This runner never connects to a desktop browser.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect, type BrowserContextOptions } from "@playwright/test";
import { z } from "zod";
import type { NativeRestoreReply, RestoreInvokeArgs } from "../../web/src/lib/backup-restore";
import type { BrokerReply, BrokerInvokeArgs } from "../../web/src/lib/vault-broker";
// Vite belongs to the web workspace, not the desktop workspace.
import { createServer } from "../../web/node_modules/vite/dist/node/index.js";

const repo = path.resolve(import.meta.dir, "../../..");
if (process.cwd() !== repo) throw new Error("Run from the assigned repository root");
const evidence = path.join(repo, ".scratch/evidence/402/headless");
fs.mkdirSync(evidence, { recursive: true });
const beforeSha = "fb3fb9f4d603c1df74bb407e3c65119b8c0874bb";
const baseline = execFileSync("git", ["show", `${beforeSha}:apps/web/src/components/vault/backup-restore.tsx`], { cwd: repo, encoding: "utf8" });
fs.writeFileSync(path.join(evidence, "before.tsx"), baseline);
const fixture = path.join(evidence, "fixture.tsx");
fs.writeFileSync(fixture, `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/index.css'; import '/src/lib/i18n';
import {BackupRestore,BackupRestoreOutcome} from '/src/components/vault/backup-restore';
import {VaultGate} from '/src/components/vault/vault-gate';
import {readVaultSessionToken} from '/src/lib/vault-client';
import {BackupRestore as Before} from './before';
function Fixture(){
 const params=new URLSearchParams(location.search);
 const [view,setView]=useState(params.has('gate')?'gate':'restore');
 window.showFixtureGate=()=>setView('gate');
 const opened=()=>setView('record');
 return <main dir="rtl" className="mx-auto max-w-3xl bg-background px-5 py-6 text-foreground">
 {view==='restore'?<><h1 className="text-2xl font-bold">النسخ الاحتياطي</h1>{params.has('before')?<Before/>:<BackupRestore/>}</>:view==='gate'&&!readVaultSessionToken()?<VaultGate status={{mode:'vault',state:'locked',legacyDatabase:false,recoveryKeyCount:1,lockedForMs:0,unlocked:false,session:false,broker:true}} onUnlocked={opened}/>:<><BackupRestoreOutcome/><p data-testid="reopened-record">Original native record</p></>}
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server = await createServer({
  root: path.join(repo, "apps/web"), configFile: path.join(repo, "apps/web/vite.config.ts"),
  server: { port: 0, open: false, host: "127.0.0.1", strictPort: true },
  plugins: [{ name: "402-headless-fixture", configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__402")) return next();
      void vite.transformIndexHtml(req.url, `<html lang="ar" dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${fixture.replaceAll("\\", "/")}"></script></body></html>`).then(html => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); });
    });
  } }],
});
await server.listen();
const address = z.object({ port: z.number().int().positive() }).parse(server.httpServer?.address());
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const results: object[] = [];
const errors: string[] = [];
try {
  for (const width of [1100, 390]) {
    const options: BrowserContextOptions = { viewport: { width, height: 1000 }, locale: "ar-DZ" };
    if (width === 1100) options.recordVideo = { dir: evidence, size: { width, height: 1000 } };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    let previewAttempts = 0, confirmationCalls = 0;
    let release: (() => void) | undefined;
    let outcome = "rolled-back";
    let served = false;
    await page.exposeFunction("fixtureInvoke", async (command: string, args?: { confirmation?: { currentCredential?: { passphrase?: string } }; credential?: { passphrase?: string } }) => {
      if (command === "backup_restore_choose") return { id: "fixture-selection", name: "نسخة المتجر - 2026.dknvbak" };
      if (command === "backup_restore_outcome") return { status: outcome, safetyDirectory: "D:/disposable-fixture/vault", safetyPath: "D:/disposable-fixture/vault/restore-original.dknvbak", selectedUnchanged: true };
      if (command === "backup_restore_preview") {
        previewAttempts++;
        if (args?.credential?.passphrase !== "incoming fixture") throw "VAULT_RESTORE_FAILED";
        return { vaultId: "fixture", vaultCreatedAt: "2020-01-01T00:00:00Z", fileModifiedAt: "2026-10-20T12:00:00Z", schemaVersion: 0, supportedSchemaVersion: 9, compatible: true, sha256: "a".repeat(64) };
      }
      if (command === "backup_restore_confirmed") {
        confirmationCalls++;
        if (args?.confirmation?.currentCredential?.passphrase !== "current fixture") throw "VAULT_RESTORE_CURRENT_CREDENTIAL";
        await new Promise<void>(resolve => { release = resolve; });
        return null;
      }
      if (command === "vault_unlock") {
        if (served) throw new Error("the vault is already unlocked");
        // Controlled delivery delay models the real stdin broker bootstrap.
        served = true;
        await new Promise(resolve => setTimeout(resolve, 300));
        return { ok: true, sessionToken: "s".repeat(43), sessionGeneration: 1 };
      }
      return null;
    });
    await page.addInitScript(() => {
      // SAFETY: a per-context adapter, never a production native command.
      const target = window as typeof window & { fixtureInvoke: (command: string, args?: RestoreInvokeArgs | BrokerInvokeArgs) => Promise<NativeRestoreReply | BrokerReply>; __TAURI_INTERNALS__?: { invoke: (command: string, args?: RestoreInvokeArgs | BrokerInvokeArgs) => Promise<NativeRestoreReply | BrokerReply> } };
      target.__TAURI_INTERNALS__ = { invoke: (command, args) => target.fixtureInvoke(command, args) };
    });
    const panel = page.getByTestId("backup-restore");
    const choose = () => panel.getByRole("button", { name: "اختيار نسخة للاستعادة", exact: true }).click();
    const inspect = async (value: string) => { await panel.locator("#restore-backup-secret").fill(value); await panel.getByRole("button", { name: "فحص النسخة", exact: true }).click(); };
    if (width === 1100) {
      await page.goto(`${origin}/__402?before`);
      await choose(); await inspect("incoming fixture");
      await expect(panel.getByTestId("restore-preview")).toBeVisible();
      await panel.screenshot({ path: path.join(evidence, "before-preview.png") });
      await panel.getByRole("button", { name: "إلغاء الاستعادة", exact: true }).click();
      await choose(); await inspect("wrong fixture");
      await expect(panel.locator("#restore-error")).toHaveCount(0);
      await expect(panel.getByRole("alert").last()).toContainText("تحقّق");
      await panel.screenshot({ path: path.join(evidence, "before-refusal.png") });
    }
    await page.goto(`${origin}/__402`);
    await expect(page.getByTestId("restore-outcome")).toBeVisible();
    await choose();
    await expect(page.getByTestId("restore-outcome")).toHaveCount(0);
    await expect(panel.locator("#restore-backup-secret")).toBeFocused();
    await inspect("wrong fixture");
    await expect(panel.locator("#restore-backup-secret")).toHaveAttribute("aria-invalid", "true");
    await expect(panel.locator("#restore-backup-secret")).toHaveAttribute("aria-describedby", "restore-error");
    await expect(panel.locator("#restore-backup-secret")).toBeFocused();
    await panel.screenshot({ path: path.join(evidence, `after-refusal-${width}.png`) });
    await inspect("incoming fixture");
    await expect(panel.getByTestId("restore-preview")).toBeVisible();
    await expect(panel.locator("h3")).toBeFocused();
    await expect(panel).toContainText("آخر تعديل للملف");
    await expect(panel).not.toContainText("2020");
    await panel.screenshot({ path: path.join(evidence, `after-preview-${width}.png`) });
    await panel.locator("#restore-current-secret").fill("wrong current");
    await panel.locator("#restore-confirm").check();
    await panel.getByRole("button", { name: "استبدال بيانات المتجر", exact: true }).click();
    await expect(panel.locator("#restore-current-secret")).toHaveAttribute("aria-invalid", "true");
    await expect(panel.locator("#restore-current-secret")).toBeFocused();
    await expect(panel.locator("#restore-confirm")).not.toBeChecked();
    await panel.locator("#restore-current-secret").fill("current fixture");
    await panel.locator("#restore-confirm").check();
    const replace = panel.getByRole("button", { name: "استبدال بيانات المتجر", exact: true });
    await replace.focus(); await page.keyboard.press("Enter");
    await expect(replace).toBeDisabled();
    await page.keyboard.press("Enter");
    await expect.poll(() => confirmationCalls).toBe(2);
    await expect(panel.getByRole("button", { name: "إلغاء الاستعادة", exact: true })).toBeDisabled();
    release?.();
    // SAFETY: fixture.tsx installs this per-page transition, never native UI.
    await page.evaluate(() => (window as typeof window & { showFixtureGate: () => void }).showFixtureGate());
    await expect(page.getByTestId("vault-passphrase")).toBeVisible();
    await expect(page.getByTestId("restore-outcome")).toContainText("أُعيدت بيانات المتجر السابقة");
    await page.getByTestId("restore-outcome").screenshot({ path: path.join(evidence, `after-rollback-${width}.png`) });
    const metrics = await page.getByTestId("restore-outcome").evaluate(el => ({ overflow: document.documentElement.scrollWidth > innerWidth, font: getComputedStyle(el).fontFamily }));
    expect(metrics.overflow).toBe(false);
    // Reproduce the superseded driver's navigation-before-unlock race.
    await page.getByTestId("vault-passphrase").fill("current fixture");
    await page.getByTestId("vault-unlock-submit").click();
    await expect.poll(() => served).toBe(true);
    await page.goto(`${origin}/__402?gate`);
    await expect(page.getByTestId("vault-passphrase")).toBeVisible();
    expect(await page.getByTestId("reopened-record").count()).toBe(0);
    results.push({ width, prematureNavigationReproducesLockedGate: true });
    // A fresh fixture launch plus an observable unlock completion prevents it.
    served = false;
    await page.getByTestId("vault-passphrase").fill("current fixture");
    await page.getByTestId("vault-unlock-submit").click();
    await expect(page.getByTestId("reopened-record")).toHaveText("Original native record");
    await page.reload();
    await expect(page.getByTestId("reopened-record")).toBeVisible();
    outcome = "restored";
    await page.reload();
    await expect(page.getByTestId("restore-outcome")).toContainText("اكتملت الاستعادة");
    await page.getByTestId("restore-outcome").screenshot({ path: path.join(evidence, `after-success-${width}.png`) });
    results.push({ width, correctedUnlockSurvivesReload: true, previewAttempts, confirmationCalls, metrics });
    const video = page.video();
    await context.close();
    if (width === 1100 && video) fs.copyFileSync(await video.path(), path.join(evidence, "restore-headless.webm"));
  }
  expect(errors).toEqual([]);
  fs.writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), beforeSha, runner: "apps/desktop/tests/restore-headless.ts", browser: browser.version(), headless: true, nativePicker: false, nativeIpc: "test-only adapter", realVaultRecovery: "separate non-UI native/API evidence", results }, null, 2));
  console.log("PASS headless RTL credential/refusal/confirmation/rollback/success states and unlock navigation race", JSON.stringify(results));
} finally { await browser.close(); await server.close(); }
