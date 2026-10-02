import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The unified-vault flow (ADR-0008 §4.6) against a dedicated API+web pair in
 * vault mode. The shared suite runs with DOKAN_VAULT=disabled because its
 * specs cover the legacy password/login path; this pair is isolated by port and
 * data dir so both stories are exercised in one Playwright run.
 */

const API_PORT = 4399;
const WEB_PORT = 5174;
const ROOT = process.cwd();
const PASSPHRASE = "shop vault passphrase";

let api: ChildProcess | undefined;
let web: ChildProcess | undefined;
let dataDir: string;

test.describe.configure({ mode: "serial" });

async function waitForOk(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function startApi(): ChildProcess {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(ROOT, "apps", "api"),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dataDir,
      DOKAN_PORT: String(API_PORT),
      DOKAN_PORT_ROOT: path.join(dataDir, "run"),
      // DOKAN_VAULT intentionally unset: the default is the encrypted vault
    },
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function stop(child: ChildProcess | undefined): void {
  if (child === undefined || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

/** Kill the child and wait for it to actually exit before reusing its port. */
async function stopAndWait(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  stop(child);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** Poll the gate until it reports the given state (the restart must land locked). */
async function waitForVaultState(state: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/api/vault/status`);
      if (response.ok) {
        // SAFETY: the status route returns { state: string } per the vault contract
        const body = (await response.json()) as { state?: string };
        if (body.state === state) return;
      }
    } catch {
      /* the old process is gone and the new one is still binding */
    }
    if (Date.now() >= deadline) throw new Error(`vault gate never reported state ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-e2e-"));
  api = startApi();
  web = spawn("bun", ["run", "--filter", "@dokan/web", "dev"], {
    cwd: ROOT,
    env: { ...process.env, DOKAN_WEB_PORT: String(WEB_PORT), DOKAN_PORT: String(API_PORT) },
    stdio: "ignore",
  });
  web.unref();
  await waitForOk(`http://127.0.0.1:${API_PORT}/api/vault/status`);
  await waitForOk(`http://127.0.0.1:${WEB_PORT}`);
});

test.afterAll(async () => {
  await stopAndWait(web);
  await stopAndWait(api);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("first run: passphrase → recovery key shown once → owner setup → the app opens", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);

  await expect(page.getByRole("heading", { name: "إنشاء الخزنة" })).toBeVisible();
  // losing both secrets is stated plainly before anything is created
  await expect(page.getByText("إذا فقدت كلمة المرور ومفتاح الاسترداد معاً")).toBeVisible();

  await page.getByTestId("vault-passphrase").fill(PASSPHRASE);
  await page.getByTestId("vault-passphrase-confirm").fill(PASSPHRASE);
  await page.getByTestId("vault-setup-submit").click();

  // the recovery key is shown once and gated on an explicit acknowledgment
  const keyElement = page.getByTestId("vault-recovery-key");
  await expect(keyElement).toBeVisible();
  const recoveryKey = (await keyElement.innerText()).trim();
  expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
  const continueButton = page.getByTestId("vault-recovery-continue");
  await expect(continueButton).toBeDisabled();
  await page.getByTestId("vault-recovery-confirm").check();
  await continueButton.click();

  // owner provisioning without a password: the passphrase is the credential
  await expect(page.getByRole("heading", { name: "مرحباً بك في دكان" })).toBeVisible();
  await expect(page.getByLabel("كلمة السر")).toHaveCount(0);
  await page.getByLabel("اسم المالك").fill("مالك الاختبار");
  await page.getByLabel("اسم المتجر").fill("متجر الاختبار");
  await page.getByLabel("رقم الهاتف").fill("0550123123");
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
});

test("after a restart the vault is locked; a wrong passphrase fails in Arabic and the right one opens", async ({ page }) => {
  // restart the API: the in-memory master key and session are gone
  await stopAndWait(api);
  api = startApi();
  await waitForVaultState("locked");

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByRole("heading", { name: "فتح الخزنة" })).toBeVisible();

  await page.getByTestId("vault-passphrase").fill("wrong passphrase");
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("vault-error")).toHaveText("كلمة المرور غير صحيحة. تحقّق منها ثم أعد المحاولة.");

  await page.getByTestId("vault-passphrase").fill(PASSPHRASE);
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();

  // the vault controls live in settings: change the passphrase, add a key
  await page.getByRole("link", { name: "الإعدادات" }).click();
  await expect(page.getByTestId("vault-settings")).toBeVisible();
  await page.getByTestId("vault-current-passphrase").fill(PASSPHRASE);
  await page.getByTestId("vault-new-passphrase").fill("a brand new vault passphrase");
  await page.getByTestId("vault-confirm-passphrase").fill("a brand new vault passphrase");
  await page.getByTestId("vault-change-submit").click();
  await expect(page.getByTestId("vault-settings-saved")).toBeVisible();
});
