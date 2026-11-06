import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawnOwnedServer, stopOwnedServers } from "./owned-server-process";
import fs from "node:fs";
import path from "node:path";
import { signIn } from "./auth-helpers";
import { resolveVaultPorts } from "../../packages/e2e-support/src/vault-ports";
import { resolveAppHost } from "../../packages/contracts/src/app-host";

async function logout(page: Page) {
  await page.locator("header").getByRole("button", { name: "خروج" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "خروج", exact: true }).click();
}

// Neither journey changes focus or asks the receiver to make a refused RPC.
test("cross-tab plaintext sign-out masks a dirty sale and identity before fresh verification", async ({ page, context }) => {
  await signIn(page);
  const receiver = await context.newPage();
  await receiver.goto("/sale");
  await expect(receiver.getByTestId("sidebar-owner-identity")).toBeVisible();
  await receiver.getByTestId("sale-quick-add").click();
  await receiver.getByTestId("sale-quick-name").fill("Private unsaved draft");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  await receiver.route("**/api/auth/get-session**", async (route) => {
    checks += 1;
    expect(new URL(route.request().url()).searchParams.get("disableCookieCache")).toBe("true");
    await gate;
    await route.continue();
  });
  let rpcCalls = 0;
  receiver.on("request", (request) => { if (request.url().includes("/api/rpc/")) rpcCalls += 1; });
  try {
    await logout(page);
    await expect(receiver.getByTestId("sale-form")).toHaveCount(0);
    await expect(receiver.getByTestId("sidebar-owner-identity")).toHaveCount(0);
    await expect(receiver.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => checks).toBeGreaterThan(0);
    expect(rpcCalls).toBe(0);
    release();
    await expect(receiver.getByTestId("login-submit")).toBeVisible();
    await expect(receiver.getByText("Private unsaved draft")).toHaveCount(0);
  } finally {
    release();
    await receiver.close();
  }
});

const ports = resolveVaultPorts();
const vaultUrl = `http://${resolveAppHost(process.env)}:${ports.web}`;
let api: ChildProcess | undefined;
let web: ChildProcess | undefined;
let dataDir: string | undefined;

async function ready(url: string) {
  await expect.poll(async () => {
    try { return (await fetch(url)).ok; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
}

test.describe("cross-tab vault credentials", () => {
  test.beforeAll(async () => {
    const fixtureDir = fs.mkdtempSync(path.join(process.cwd(), ".scratch/cross-tab-vault-"));
    dataDir = fixtureDir;
    api = spawnOwnedServer("bun", ["src/main.ts"], {
      cwd: path.join(process.cwd(), "apps/api"),
      env: { ...process.env, DOKAN_VAULT: "enabled", DOKAN_PORT: String(ports.api), DOKAN_WEB_PORT: String(ports.web), DOKAN_DATA_DIR: fixtureDir, DOKAN_PORT_ROOT: path.join(fixtureDir, "run") },
      stdio: "ignore",
    });
    web = spawnOwnedServer("bun", ["run", "--filter", "@dokan/web", "dev"], {
      cwd: process.cwd(), env: { ...process.env, DOKAN_PORT: String(ports.api), DOKAN_WEB_PORT: String(ports.web) }, stdio: "ignore",
    });
    await ready(`http://127.0.0.1:${ports.api}/api/vault/status`);
    await ready(`http://127.0.0.1:${ports.web}`);
  });
  test.afterAll(async () => {
    await stopOwnedServers([web, api]);
    if (dataDir !== undefined) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  test("unconfirmed sender stays held while receiver verifies its own live cookie; confirmed logout gates a sibling", async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto(vaultUrl);
    await page.getByTestId("vault-passphrase").fill("cross tab vault passphrase");
    await page.getByTestId("vault-passphrase-confirm").fill("cross tab vault passphrase");
    await page.getByTestId("vault-setup-submit").click();
    await expect(page.getByTestId("vault-recovery-key")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("vault-recovery-confirm").check();
    await page.getByTestId("vault-recovery-continue").click();
    await page.getByLabel("اسم المالك").fill("مالك الاختبار");
    await page.getByLabel("اسم المتجر").fill("متجر الاختبار");
    await page.getByLabel("رقم الهاتف").fill("0550123123");
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await expect(page.getByTestId("sidebar-owner-identity")).toBeVisible();
    const receiver = await context.newPage();
    await receiver.goto(vaultUrl);
    await expect(receiver.getByTestId("sidebar-owner-identity")).toBeVisible();
    await page.route("**/api/vault/logout", (route) => route.fulfill({ status: 503, json: { error: { code: "VAULT_UNREACHABLE" } } }));
    await page.route("**/api/auth/sign-out", (route) => route.abort());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let statusChecks = 0;
    let plaintextChecks = 0;
    receiver.on("request", (request) => { if (request.url().includes("/api/auth/get-session")) plaintextChecks += 1; });
    await receiver.route("**/api/vault/status", async (route) => {
      statusChecks += 1;
      await gate;
      await route.continue();
    });
    try {
      await logout(page);
      await expect(page.getByTestId("vault-passphrase")).toBeVisible();
      await expect(receiver.getByTestId("sidebar-owner-identity")).toHaveCount(0);
      await expect(receiver.getByTestId("dashboard-page")).toHaveCount(0);
      await expect.poll(() => statusChecks).toBeGreaterThan(0);
      release();
      await expect(receiver.getByTestId("sidebar-owner-identity")).toBeVisible();
      expect(plaintextChecks).toBe(0);
      await page.reload();
      await expect(page.getByTestId("vault-passphrase")).toBeVisible();
      await expect(page.getByTestId("sidebar-owner-identity")).toHaveCount(0);
      const sibling = await context.newPage();
      try {
        await sibling.goto(vaultUrl);
        await expect(sibling.getByTestId("sidebar-owner-identity")).toBeVisible();
        await logout(receiver);
        await expect(sibling.getByTestId("sidebar-owner-identity")).toHaveCount(0);
        await expect(sibling.getByTestId("dashboard-page")).toHaveCount(0);
        await expect(sibling.getByTestId("vault-passphrase")).toBeVisible();
      } finally { await sibling.close(); }
    } finally {
      release();
      await receiver.close();
    }
  });
});
