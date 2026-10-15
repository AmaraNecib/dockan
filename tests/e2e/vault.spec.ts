import { expect, test, type Locator } from "@playwright/test";
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

// #202 — the vault pair is configurable so two lanes can run vault suites side
// by side. The defaults are the historical literals, so a run that sets nothing
// is unchanged. Resolved once here and read by every consumer below: the spawn
// env, the health poll, the vault-status poll and the page navigations, so the
// servers we start and the servers we talk to can never be different ports.
const API_PORT = Number(process.env.DOKAN_VAULT_PORT ?? 4399);
const WEB_PORT = Number(process.env.DOKAN_VAULT_WEB_PORT ?? 5174);
const ROOT = process.cwd();
const PASSPHRASE = "shop vault passphrase";
const NEW_PASSPHRASE = "brand new shop passphrase";

let api: ChildProcess | undefined;
let web: ChildProcess | undefined;
let dataDir: string;
/** shown exactly once by the first test, used by the recovery test after a restart */
let recoveryKey = "";

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

test("the passphrase fields share one app-controlled reveal, pinned to the left edge", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByRole("heading", { name: "إنشاء الخزنة" })).toBeVisible();

  const first = page.getByTestId("vault-passphrase");
  const confirm = page.getByTestId("vault-passphrase-confirm");
  const firstToggle = page.getByTestId("vault-passphrase-toggle");
  const confirmToggle = page.getByTestId("vault-passphrase-confirm-toggle");

  await expect(first).toHaveAttribute("type", "password");
  await expect(confirm).toHaveAttribute("type", "password");
  await expect(firstToggle).toBeVisible();
  await expect(confirmToggle).toBeVisible();
  // the input text runs RTL: dots start at the right edge
  await expect(first).toHaveCSS("direction", "rtl");
  await expect(confirm).toHaveCSS("direction", "rtl");

  // the eye sits on the same side of both fields, and that side is the left
  // edge. The reported bug was the confirm field mirroring the first one.
  const eyeOffsetFromLeft = async (field: Locator, toggle: Locator): Promise<number> => {
    const fieldBox = await field.boundingBox();
    const toggleBox = await toggle.boundingBox();
    if (fieldBox === null || toggleBox === null) throw new Error("missing field bounding box");
    expect(toggleBox.x).toBeGreaterThanOrEqual(fieldBox.x);
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 1);
    return Math.round(toggleBox.x - fieldBox.x);
  };
  const firstOffset = await eyeOffsetFromLeft(first, firstToggle);
  const confirmOffset = await eyeOffsetFromLeft(confirm, confirmToggle);
  expect(firstOffset).toBe(confirmOffset);
  const confirmBox = await confirm.boundingBox();
  if (confirmBox === null) throw new Error("missing confirm box");
  expect(firstOffset).toBeLessThan(confirmBox.width / 2);

  // the eye is painted from theme tokens, so it repaints for dark mode
  const lightEye = await firstToggle.evaluate((element) => getComputedStyle(element).color);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const darkEye = await firstToggle.evaluate((element) => getComputedStyle(element).color);
  expect(darkEye).not.toBe(lightEye);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // the toggle survives repeated use and further typing
  await firstToggle.click();
  await expect(first).toHaveAttribute("type", "text");
  await first.fill("typed while revealed");
  await firstToggle.click();
  await expect(first).toHaveAttribute("type", "password");
  await expect(firstToggle).toBeVisible();
  await first.fill("still togglable");
  await expect(first).toHaveAttribute("type", "password");
  await expect(firstToggle).toBeVisible();
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
  const shownKey = (await keyElement.innerText()).trim();
  expect(shownKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
  recoveryKey = shownKey;
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

test("after a restart the vault is locked; recovery unlocks it and sets a new working passphrase", async ({ page }) => {
  // restart the API: the in-memory master key and session are gone
  await stopAndWait(api);
  api = startApi();
  await waitForVaultState("locked");

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByRole("heading", { name: "فتح الخزنة" })).toBeVisible();

  await page.getByTestId("vault-passphrase").fill("wrong passphrase");
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("vault-error")).toHaveText("كلمة المرور غير صحيحة. تحقّق منها ثم أعد المحاولة.");

  // the recovery key opens the vault without the forgotten passphrase
  await page.getByTestId("vault-use-recovery").click();
  await page.getByTestId("vault-recovery-input").fill(recoveryKey);
  await page.getByTestId("vault-recovery-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();

  // ... and sets a brand-new passphrase from settings, no current one needed
  await page.getByRole("link", { name: "الإعدادات" }).click();
  await expect(page.getByTestId("vault-settings")).toBeVisible();
  await page.getByTestId("vault-show-recovery-reset").click();
  await page.getByTestId("vault-reset-recovery-key").fill(recoveryKey);
  await page.getByTestId("vault-reset-new-passphrase").fill(NEW_PASSPHRASE);
  await page.getByTestId("vault-reset-submit").click();
  await expect(page.getByTestId("vault-settings-saved")).toBeVisible();

  // a further restart only accepts the NEW passphrase
  await stopAndWait(api);
  api = startApi();
  await waitForVaultState("locked");
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.getByTestId("vault-passphrase").fill(NEW_PASSPHRASE);
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
});
