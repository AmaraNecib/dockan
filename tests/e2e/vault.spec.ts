import { expect, test, type Locator } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// #202/#206 — the vault pair is configurable so two lanes can run vault suites
// side by side; the resolver (and its unit tests) live in packages/e2e-support
// (imported by path, because Playwright only transpiles TS outside node_modules)
// and are unit-tested by `bun run test`.
// Resolved once here and read by every consumer below: the spawn env, the health
// poll, the vault-status poll and the page navigations, so the servers we start
// and the servers we talk to can never be different ports.
import { resolveVaultPorts } from "../../packages/e2e-support/src/vault-ports";

/**
 * The unified-vault flow (ADR-0008 §4.6) against a dedicated API+web pair in
 * vault mode. The shared suite runs with DOKAN_VAULT=disabled because its
 * specs cover the legacy password/login path; this pair is isolated by port and
 * data dir so both stories are exercised in one Playwright run.
 */

const { api: API_PORT, web: WEB_PORT } = resolveVaultPorts();
const ROOT = process.cwd();
const PASSPHRASE = "shop vault passphrase";
const NEW_PASSPHRASE = "brand new shop passphrase";
/**
 * The Argon2id setup/unlock KDF sits above OWASP's floor (m=32 MiB, t=3), which
 * measures ~1s idle but ~10s on a machine loaded by sibling lanes. Playwright's
 * 5s expect default is shorter than the KDF, so those assertions name a bound.
 */
const VAULT_KDF_TIMEOUT_MS = 20_000;

let api: ChildProcess | undefined;
let web: ChildProcess | undefined;
/** the second instance on the same folder; it can only answer with the refusal */
let refusal: ChildProcess | undefined;
let dataDir: string;
/** shown exactly once by the first test, used by the recovery test after a restart */
let recoveryKey = "";

test.describe.configure({ mode: "serial", timeout: 120_000 });

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

/** A port the kernel just proved free, for the second instance's own listener. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a live listening TCP socket's address() is an AddressInfo
      const assigned = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(assigned));
    });
    server.on("error", reject);
  });
}

/**
 * Wait for the second instance's refusal and hand back what a browser receives
 * on the route the app actually calls. The body comes from the process
 * (apps/api #275 answers 503 + VAULT_LOCKED_BY_OTHER_INSTANCE here), so the
 * screen asserted below is checked against the wire shape the API sends rather
 * than a body this spec invented.
 */
async function waitForRefusal(onPort: number, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${onPort}/api/vault/status`);
      if (response.status === 503) return response;
    } catch {
      /* the child is still binding */
    }
    if (Date.now() >= deadline) throw new Error(`no refusal answered on ${onPort}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function startApi(onPort = API_PORT): ChildProcess {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(ROOT, "apps", "api"),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dataDir,
      DOKAN_PORT: String(onPort),
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
  await stopAndWait(refusal);
  await stopAndWait(web);
  await stopAndWait(api);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The dev proxy must forward the browser's own `Host` (#319 round 3), and this
 * is the ONLY case that can tell the two proxy configurations apart.
 *
 * `apps/web/vite.config.ts` sets `changeOrigin: false`, and nothing failed if a
 * future edit (or a `proxy_set_header Host $proxy_host`) rewrote the header: the
 * api would then address every proxied request on its OWN port, every browser
 * write would look like a foreign origin, and the round-1 bug would be back
 * silently. The api's origin gate compares the page's `Origin` with the host it
 * was ADDRESSED on, so the answers invert when the proxy rewrites `Host`.
 *
 * It runs FIRST because the suite is serial (one shared database): under
 * `changeOrigin: true` the setup POST of test 3 is refused and Playwright stops
 * the file there, so a discriminating case anywhere after it never runs — the
 * mutation looked like "one red test" and this one was never reached. The two
 * requests below need no vault, no cookie and no session: `GET
 * /api/vault/recovery-keys` runs the loopback peer check and the origin gate
 * before it looks for a credential, so the answer is 401 for same-origin and
 * 403 for a foreign one.
 *
 * The real flow through the proxy (an unlock whose minted cookie survives a
 * reload) needs a configured vault, so it lives in its own case further down.
 */
test("the browser's own Host survives the dev proxy (#319 round 3)", async ({ request }) => {
  const ownOrigin = await request.get(`http://127.0.0.1:${WEB_PORT}/api/vault/recovery-keys`, {
    headers: { origin: `http://127.0.0.1:${WEB_PORT}` },
  });
  expect(ownOrigin.status()).toBe(401);
  // SAFETY: the vault routes answer `{ error: { code } }` by contract
  expect(((await ownOrigin.json()) as { error?: { code?: string } }).error?.code).toBe("VAULT_NOT_UNLOCKED");

  // the same request naming the API's port is a FOREIGN origin: the api judged
  // the host the browser addressed (the web port), not the one it listens on
  const apiOrigin = await request.get(`http://127.0.0.1:${WEB_PORT}/api/vault/recovery-keys`, {
    headers: { origin: `http://127.0.0.1:${API_PORT}` },
  });
  expect(apiOrigin.status()).toBe(403);
  // SAFETY: same contract as above: a refusal carries a stable code
  expect(((await apiOrigin.json()) as { error?: { code?: string } }).error?.code).toBe("VAULT_ORIGIN_FORBIDDEN");
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

test("an empty vault passphrase shows Arabic, never the browser bubble", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByRole("heading", { name: "إنشاء الخزنة" })).toBeVisible();

  // the browser's own constraint UI is switched off; the app speaks instead
  await expect(page.locator("form")).toHaveAttribute("novalidate", "");

  await page.getByTestId("vault-setup-submit").click();

  await expect(page.getByTestId("vault-error")).toHaveText("كلمة مرور الخزنة قصيرة جداً. استعمل ٨ أحرف على الأقل.");
  const passphrase = page.getByTestId("vault-passphrase");
  await expect(passphrase).toBeFocused();
  await expect(passphrase).toHaveAttribute("aria-invalid", "true");
  expect(
    await passphrase.evaluate((el) => {
      // SAFETY: the locator resolves to the required vault passphrase <input>
      return (el as HTMLInputElement).validity.valueMissing;
    }),
  ).toBe(true);
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
  await expect(keyElement).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
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
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
});

test("after a restart the vault is locked; recovery unlocks it and sets a new working passphrase", async ({ page }) => {
  // restart the API: the in-memory master key and session are gone
  await stopAndWait(api);
  api = startApi();
  await waitForVaultState("locked");

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByRole("heading", { name: "فتح الخزنة" })).toBeVisible();

  // an empty passphrase is refused by the app, not the browser
  await expect(page.locator("form")).toHaveAttribute("novalidate", "");
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("vault-error")).toHaveText("أدخل كلمة مرور الخزنة.");
  // the field-blamed refusal points the alert at the empty field (#109)
  await expect(page.getByTestId("vault-passphrase")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("vault-passphrase")).toHaveAttribute("aria-describedby", "vault-error");

  await page.getByTestId("vault-passphrase").fill("wrong passphrase");
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("vault-error")).toHaveText("كلمة المرور غير صحيحة. تحقّق منها ثم أعد المحاولة.", { timeout: VAULT_KDF_TIMEOUT_MS });
  // the server error names no field, so the empty-field blame cannot survive (#217)
  await expect(page.getByTestId("vault-passphrase")).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByTestId("vault-passphrase")).not.toHaveAttribute("aria-describedby", "vault-error");

  // the recovery key opens the vault without the forgotten passphrase
  await page.getByTestId("vault-use-recovery").click();
  await page.getByTestId("vault-recovery-input").fill(recoveryKey);
  await page.getByTestId("vault-recovery-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });

  // ... and sets a brand-new passphrase from settings, no current one needed
  await page.getByRole("link", { name: "الإعدادات" }).click();
  await expect(page.getByTestId("vault-settings")).toBeVisible();
  await page.getByTestId("vault-show-recovery-reset").click();
  await page.getByTestId("vault-reset-recovery-key").fill(recoveryKey);
  await page.getByTestId("vault-reset-new-passphrase").fill(NEW_PASSPHRASE);
  await page.getByTestId("vault-reset-submit").click();
  await expect(page.getByTestId("vault-settings-saved")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });

  // a further restart only accepts the NEW passphrase
  await stopAndWait(api);
  api = startApi();
  await waitForVaultState("locked");
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.getByTestId("vault-passphrase").fill(NEW_PASSPHRASE);
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
});

test("an unlock through the dev proxy keeps its cookie across a reload (#319 round 3)", async ({ page }) => {
  // The behavioural half of the proxy case: the origin pair above proves the
  // header is forwarded, and this proves the consequence the owner feels — an
  // unlock through vite mints a cookie the api accepts after a reload, instead
  // of the page being refused as a foreign origin on every write.
  //
  // It needs the vault test 3 created and test 4's new passphrase, so it stays
  // after them; it is not the discriminating case (that one runs first).
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await expect(page.getByTestId("vault-passphrase")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
  await page.getByTestId("vault-passphrase").fill(NEW_PASSPHRASE);
  await page.getByTestId("vault-unlock-submit").click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });

  // the minted cookie is the credential the app then works on: a reload asks the
  // api again (through the proxy, with the browser's own jar) and lands in the
  // app instead of the gate — which only holds if the unlock reply's `Set-Cookie`
  // arrived and the api accepts the session it minted for this window
  await page.reload();
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
  await expect(page.getByTestId("vault-passphrase")).toHaveCount(0);
});

test("a second instance on this folder: the browser is told the folder is in use (#276)", async ({ page }) => {
  // The first instance above still holds the folder, so this child cannot take
  // the lock and serves the refusal on its own port (ADR-0012). Its /api/vault
  // answer is the body the web must read; the dev proxy points at the first
  // instance, so the body is fetched here and replayed through the SPA — the
  // transport between the refuser and the page is the only part not exercised.
  const refusalPort = await freePort();
  refusal = startApi(refusalPort);
  const refusalResponse = await waitForRefusal(refusalPort);
  expect(refusalResponse.status).toBe(503);
  const refusalBody = await refusalResponse.text();
  expect(refusalBody).toContain("VAULT_LOCKED_BY_OTHER_INSTANCE");

  await page.route("**/api/vault/status", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: refusalBody }),
  );
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);

  const inUse = page.getByTestId("vault-status-in-use");
  await expect(inUse).toBeVisible();
  // #277/#298: the screen names what happens next — this instance retries the
  // folder on its own schedule and takes it when the other copy closes — so the
  // copy must not ask for the restart the feature removed. The exact match is
  // the pin: a carried-over "then reopen the app" sentence fails here.
  await expect(inUse).toHaveText("البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى، وستأخذ هذه النسخة المجلد من تلقاء نفسها.");
  // the server-down story must not appear for a refusal
  await expect(page.getByTestId("vault-status-unavailable")).toHaveCount(0);
  await expect(page.getByText("تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.")).toHaveCount(0);

  // Closing the other copy and retrying reaches the real gate. What this half
  // proves is the SPA's retry path through the dev proxy to the OWNER instance
  // (the proxy points at the first copy, not at the refuser); the self-take — a
  // refused instance taking the folder by itself — is proved on the wire in the
  // last test of this file, because the browser cannot see the refuser at all.
  await stopAndWait(refusal);
  refusal = undefined;
  await page.unroute("**/api/vault/status");
  await page.getByTestId("vault-status-retry").click();
  await expect(page.getByTestId("vault-passphrase")).toBeVisible({ timeout: VAULT_KDF_TIMEOUT_MS });
});

test("a lock held by an alive pid that stopped beating names the lock file (#283)", async ({ page }) => {
  // The API sets `staleHeartbeat` when the recorded pid answers alive while the
  // heartbeat is several windows old, the recycled-pid box (lock.test.ts proves
  // the emission). That state cannot be forced through a live second instance,
  // so the wire body is built here and replayed through the SPA; the screen the
  // owner would read is what is under test.
  await page.route("**/api/vault/status", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } }),
    }),
  );
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  const stale = page.getByTestId("vault-status-stale-lock");
  await expect(stale).toBeVisible();
  // the recycled-pid story runs on the same retry loop, so it also promises the
  // self-take; only the unreadable-lock page still says "then reopen the app"
  await expect(stale).toHaveText(
    "القفل ممسوك بعملية لا تبدو نسخة أخرى من دكان. إن لم تكن هناك نسخة أخرى مفتوحة، فاحذف ملف vault.lock من مجلد البيانات، وستأخذ هذه النسخة المجلد من تلقاء نفسها.",
  );
  await expect(page.getByTestId("vault-status-in-use")).toHaveCount(0);
});

test("a genuinely unreachable server keeps the server-down copy (#276)", async ({ page }) => {
  // the status call dies at the client, which is the honest "server down" case
  await page.route("**/api/vault/status", (route) => route.abort("failed"));
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  const down = page.getByTestId("vault-status-unavailable");
  await expect(down).toBeVisible();
  await expect(down).toHaveText("تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.");
  await expect(page.getByTestId("vault-status-in-use")).toHaveCount(0);
});

test("a refused instance takes this folder by itself once the first copy goes (#277/#298)", async () => {
  // Everything above proves the refusal's COPY. This proves the behaviour the
  // copy promises, which no assertion in this file did: a live refused instance
  // takes the folder with no restart, publishes the canonical port record the
  // proxy follows, and then serves the vault gate. It is the last test in the
  // file because it takes the first instance away for good.
  const runDir = path.join(dataDir, "run");
  const portFile = path.join(runDir, ".dokan-port");
  const lockFile = path.join(dataDir, "vault.lock");
  const refusalPort = await freePort();
  refusal = startApi(refusalPort);
  await waitForRefusal(refusalPort);
  const refusalPid = refusal.pid;
  if (refusalPid === undefined) throw new Error("the refused instance has no pid");

  // The first copy owns the folder and the canonical record the proxy reads
  expect(fs.readFileSync(portFile, "utf8")).toBe(String(API_PORT));

  // The retry route answers on the REFUSED instance itself, not only through the
  // dev proxy (which points at the owner). Deleting POST /api/vault/reclaim from
  // main.ts used to leave this spec green, because the only POST went through
  // the proxy to the owner. Here the ask goes to the refuser's own port, and the
  // folder is still held, so the honest answer is "asked, not taken".
  const asked = await fetch(`http://127.0.0.1:${refusalPort}/api/vault/reclaim`, { method: "POST" });
  expect(asked.status).toBe(200);
  expect(await asked.json()).toEqual({ ok: true, taken: false });

  // it goes away without a clean close (SIGKILL/taskkill leaves `vault.lock`
  // behind), which is the harder of the two stories: the refused instance has
  // to reclaim a stale record, not just see a free path
  await stopAndWait(api);
  api = undefined;

  // the refused instance takes the folder on its own backoff: no restart, and
  // the lock record names it
  const takeDeadline = Date.now() + 45_000;
  for (;;) {
    let ownerPid: number | undefined;
    try {
      // SAFETY: the lock record is JSON written by a running sidecar
      ownerPid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number }).pid;
    } catch {
      ownerPid = undefined;
    }
    if (ownerPid === refusalPid) break;
    if (Date.now() >= takeDeadline) throw new Error("the refused instance never took the folder");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // the canonical record follows without anyone restarting anything: this is
  // the file the dev proxy walks, so its arrival is what makes the takeover
  // visible to the browser
  for (;;) {
    if (fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8") === String(refusalPort)) break;
    if (Date.now() >= takeDeadline) throw new Error("the canonical port record never followed the takeover");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // and the instance that kept the promise serves the gate, not the refusal:
  // this data dir has a vault, so the gate's own answer is `locked`
  const status = await fetch(`http://127.0.0.1:${refusalPort}/api/vault/status`);
  expect(status.status).toBe(200);
  // SAFETY: the status route returns { state: string } per the vault contract
  expect(((await status.json()) as { state?: string }).state).toBe("locked");
});
