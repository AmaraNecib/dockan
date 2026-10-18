/**
 * #285 visual-evidence capture.
 *
 * Runs the real API twice on one data folder: the first instance owns the lock,
 * the second is the real refusal app (`VAULT_LOCKED_BY_OTHER_INSTANCE` on
 * `/api/vault/status`). A real Vite dev server proxies `/api` at the refuser, so
 * the browser receives the refusal over the real transport. No stub, no route
 * interception.
 *
 * Captures the branch screen, then checks out develop's three changed web files
 * and captures the old screen, then restores HEAD. Never commits.
 *
 * Run from the worktree root: `bun .scratch/evidence/285/capture.mjs`.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../../..");
const API_ENTRY = path.join(ROOT, "apps", "api", "src", "main.ts");
const LOG = fs.createWriteStream(path.join(HERE, "capture.log"), { flags: "a" });

/** The three web files this branch changes; develop's copies are the "before". */
const CHANGED_WEB_FILES = [
  "apps/web/src/App.tsx",
  "apps/web/src/lib/vault-client.ts",
  "apps/web/src/components/vault/vault-gate.tsx",
];

const log = (line) => {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  LOG.write(`${stamped}\n`);
  process.stdout.write(`${stamped}\n`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const assigned = server.address().port;
      server.close(() => resolve(assigned));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop(child) {
  if (child === undefined || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function stopAndWait(child) {
  if (child === undefined || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", () => resolve()));
  stop(child);
  await Promise.race([exited, sleep(5_000)]);
}

function startApi({ dataDir, port }) {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(ROOT, "apps", "api"),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dataDir,
      DOKAN_PORT: String(port),
      DOKAN_PORT_ROOT: path.join(dataDir, "run"),
    },
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function startWeb({ webPort, apiPort }) {
  const child = spawn("bun", ["run", "--filter", "@dokan/web", "dev"], {
    cwd: ROOT,
    env: { ...process.env, DOKAN_WEB_PORT: String(webPort), DOKAN_PORT: String(apiPort) },
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitFor(url, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (await predicate(response)) return response;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what} at ${url}`);
    await sleep(250);
  }
}

function git(args) {
  const result = spawn("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  result.stdout.on("data", (chunk) => (out += chunk));
  result.stderr.on("data", (chunk) => (out += chunk));
  return new Promise((resolve, reject) =>
    result.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")}: ${out}`)))),
  );
}

async function captureState({ state, expectedTestId, webPort, apiPort, outDir }) {
  const web = startWeb({ webPort, apiPort });
  try {
    await waitFor(`http://127.0.0.1:${webPort}/`, (r) => r.ok, 60_000, "vite");
    const browser = await chromium.launch();
    try {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ar-DZ" });
      const page = await desktop.newPage();
      await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: "domcontentloaded" });
      await page.getByTestId(expectedTestId).waitFor({ timeout: 30_000 });
      const alertText = await page.getByTestId(expectedTestId).innerText();
      await page.screenshot({ path: path.join(outDir, `${state}.png`) });
      log(`${state}: desktop captured (${expectedTestId}) text=${JSON.stringify(alertText)}`);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, `${state}-phone.png`) });
      log(`${state}: phone captured`);
      await desktop.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopAndWait(web);
  }
}

const outDir = HERE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-285-evidence-"));
let owner;
let refuser;
let dirty = false;

try {
  fs.rmSync(path.join(outDir, "capture.log"), { force: true });
  const status = await git(["status", "--porcelain"]);
  const tracked = status.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("??"));
  if (tracked.length > 0) throw new Error(`worktree has tracked modifications, refusing to run:\n${tracked.join("\n")}`);

  const apiOwnerPort = await freePort();
  const apiRefuserPort = await freePort();
  const webPort = await freePort();
  log(`ports owner=${apiOwnerPort} refuser=${apiRefuserPort} web=${webPort} dataDir=${dataDir}`);

  owner = startApi({ dataDir, port: apiOwnerPort });
  await waitFor(`http://127.0.0.1:${apiOwnerPort}/api/vault/status`, (r) => r.ok, 30_000, "owner vault status");
  log("owner API healthy (holds the folder lock)");

  refuser = startApi({ dataDir, port: apiRefuserPort });
  const refusal = await waitFor(
    `http://127.0.0.1:${apiRefuserPort}/api/vault/status`,
    async (r) => r.status === 503,
    30_000,
    "refuser 503",
  );
  const refusalBody = await refusal.text();
  if (!refusalBody.includes("VAULT_LOCKED_BY_OTHER_INSTANCE")) {
    throw new Error(`refusal body lacks the code: ${refusalBody}`);
  }
  log(`refuser API answered 503 ${refusalBody}`);

  await captureState({ state: "after", expectedTestId: "vault-status-in-use", webPort, apiPort: apiRefuserPort, outDir });

  // develop's copies of the three changed web files: the old, wrong screen.
  dirty = true;
  await git(["checkout", "develop", "--", ...CHANGED_WEB_FILES]);
  log("checked out develop's web files for the before capture");
  await captureState({ state: "before", expectedTestId: "vault-status-unavailable", webPort, apiPort: apiRefuserPort, outDir });

  await git(["checkout", "HEAD", "--", ...CHANGED_WEB_FILES]);
  dirty = false;
  log("restored HEAD's web files");
} catch (error) {
  log(`ERROR: ${error.message}`);
  throw error;
} finally {
  if (dirty) {
    try {
      await git(["checkout", "HEAD", "--", ...CHANGED_WEB_FILES]);
      log("restored HEAD's web files in the finally block");
    } catch (restoreError) {
      log(`FAILED to restore HEAD's web files: ${restoreError.message}`);
    }
  }
  await stopAndWait(refuser);
  await stopAndWait(owner);
  fs.rmSync(dataDir, { recursive: true, force: true });
  log("stopped servers");
}
