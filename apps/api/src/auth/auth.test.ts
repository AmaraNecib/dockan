import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HEAVY_TEST_TIMEOUT_MS, setHeavyDefaultTimeout } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAppConfig } from "../config";
import { authTrustedOrigins } from "./auth";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "../lib/logger";
import { normalizeAlgerianPhone, phoneToUsername } from "../lib/phone";
import { ensureSessionSecret } from "../lib/session-secret";
import { createRpcRouter } from "../rpc/router";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { createAuth, type BetterAuthInstance } from "./auth";

// Every test drives the real auth/RPC surface against the shared database.
setHeavyDefaultTimeout();

const PHONE = "+213550123123";
const USERNAME = phoneToUsername(PHONE);
const PASSWORD = "dokan-1234";

// SAFETY: the oRPC client is typed by the contract; a narrow interface keeps
// the tests honest without dragging client type machinery in
type RpcApi = {
  categoriesList(): Promise<{ items: Array<{ id: string; name: string }> }>; // ticket 03 owns this guarded procedure
};

let dir: string;
let conn: Connection;
let store: StorePort;
let auth: BetterAuthInstance;
let app: ReturnType<typeof createApp>;

const linkFor = (cookieToSend: string) =>
  new RPCLink({
    url: "http://localhost/api/rpc",
    fetch: (request) => {
      const headers = Object.fromEntries(request.headers.entries());
      if (cookieToSend !== "") headers.cookie = cookieToSend;
      return Promise.resolve(app.fetch(new Request(request, { headers })));
    },
  });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-auth-"));
  const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  const logger = new AppLogger(dir);
  // One universal build (ADR-0008 §4.2): the signing secret is a normal row
  // generated on first use, never a build input.
  auth = createAuth(conn.db, config, await ensureSessionSecret(store));
  app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });

  // Provision the single owner the way the app does: public first-run setup.
  const setupClient: DokanClient = createORPCClient(linkFor(""));
  await setupClient.firstTimeSetup({ ownerName: "مالك الاختبار", phoneNumber: PHONE, password: PASSWORD, storeName: "متجر الاختبار" });
}, HEAVY_TEST_TIMEOUT_MS);

afterAll(() => {
  conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

const signIn = (username: string, password: string) =>
  auth.handler(
    new Request("http://localhost/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  );

function clientWith(fetchImpl: (request: Request) => Promise<Response>): RpcApi {
  // SAFETY: RPCLink converts procedure calls into POSTs to /api/rpc; the
  // injected fetch lets tests carry cookies through app.fetch in-process
  const link = new RPCLink({ url: "http://localhost/api/rpc", fetch: (request) => fetchImpl(request) });
  // SAFETY: the typed client from the link implements exactly the narrow
  // surface declared above; the two types differ only in surface breadth
  return createORPCClient(link) as RpcApi;
}

describe("phone normalization", () => {
  it("accepts the Algerian formats and rejects others", () => {
    expect(normalizeAlgerianPhone("0550123123")).toBe("+213550123123");
    expect(normalizeAlgerianPhone("+213550123123")).toBe("+213550123123");
    expect(normalizeAlgerianPhone("213550123123")).toBe("+213550123123");
    expect(normalizeAlgerianPhone("055 012 31 23")).toBe("+213550123123");
    expect(normalizeAlgerianPhone("2660123123")).toBeNull();
    expect(normalizeAlgerianPhone("abc")).toBeNull();
  });

  // issue #108 — the Arabic-keyboard numerals must be one identity with ASCII
  it("folds Arabic-Indic digits to the same canonical ASCII number", () => {
    expect(normalizeAlgerianPhone("٠٥٥٠١٢٣١٢٣")).toBe("+213550123123");
  });

  it("folds Extended Arabic-Indic digits to the same canonical ASCII number", () => {
    expect(normalizeAlgerianPhone("۰۵۵۰۱۲۳۱۲۳")).toBe("+213550123123");
  });

  it("folds mixed digit sets and separators in one number", () => {
    expect(normalizeAlgerianPhone("٠٥٥ 012 ٣١ ۲۳")).toBe("+213550123123");
    expect(normalizeAlgerianPhone("٠٥٥-012-٣١-۲۳")).toBe("+213550123123");
  });

  it("keeps the stored/returned value ASCII and identical across digit sets", () => {
    const ascii = normalizeAlgerianPhone("0550123123");
    expect(normalizeAlgerianPhone("٠٥٥٠١٢٣١٢٣")).toBe(ascii);
    expect(normalizeAlgerianPhone("۰۵۵۰۱۲۳۱۲۳")).toBe(ascii);
    expect(ascii).toBe("+213550123123");
  });
});

describe("auth seam", () => {
  it("blocks account creation over http (single-admin boundary)", async () => {
    // vault mode does not mount better-auth routes at all (finding C10)
    const vaultAttempt = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213699999999", password: "x", name: "x" }),
      }),
    );
    expect(vaultAttempt.status).toBe(404);

    // the legacy plaintext build keeps the route but refuses sign-up
    const plaintextConfig = createAppConfig({
      DOKAN_DATA_DIR: dir,
      DOKAN_DB_PATH: path.join(dir, "test.db"),
      DOKAN_VAULT: "disabled",
    });
    const plaintextApp = createApp({
      config: plaintextConfig,
      logger: new AppLogger(dir),
      auth,
      rpcRouter: createRpcRouter({ db: conn.db, config: plaintextConfig, logger: new AppLogger(dir), store, auth }),
    });
    const plaintextAttempt = await plaintextApp.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213699999999", password: "x", name: "x" }),
      }),
    );
    expect(plaintextAttempt.status).toBe(403);
  });

  it("signs in the provisioned owner with the phone digits", async () => {
    const login = await signIn(USERNAME, PASSWORD);
    expect(login.status).toBe(200);
    // SAFETY: a 200 sign-in response always carries the user object
    const body = (await login.json()) as { user: { username: string } };
    expect(body.user.username).toBe(USERNAME);
  });

  // issue #108 — the login path itself, not just the pure normaliser
  it("signs in the owner when the phone is typed in Arabic-Indic digits", async () => {
    const normalized = normalizeAlgerianPhone("٠٥٥٠١٢٣١٢٣");
    expect(normalized).toBe(PHONE);
    // SAFETY: the shared normaliser returned a canonical value just above
    const login = await signIn(phoneToUsername(normalized!), PASSWORD);
    expect(login.status).toBe(200);
    // SAFETY: a 200 sign-in response always carries the user object
    const body = (await login.json()) as { user: { username: string } };
    expect(body.user.username).toBe(USERNAME);
  });

  it("rejects a wrong password and an unknown phone alike", async () => {
    expect((await signIn(USERNAME, "wrong-pass")).status).toBe(401);
    expect((await signIn("213700000000", PASSWORD)).status).toBe(401);
  });

  it("rejects a session that is not the provisioned admin", async () => {
    const login = await signIn(USERNAME, PASSWORD);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    const client = clientWith((request) => {
      const headers = Object.fromEntries(request.headers.entries());
      const withCookie = new Request(request, { headers: { ...headers, cookie } });
      return Promise.resolve(app.fetch(withCookie));
    });
    // point the admin identity marker at someone else: the real session now
    // fails the identity wall, not the session check
    const realAdminId = await store.getSetting("adminUserId");
    await store.setSetting("adminUserId", "00000000-0000-4000-8000-000000000000");
    await expect(client.categoriesList()).rejects.toMatchObject({ code: "FORBIDDEN" });
    if (realAdminId !== undefined) await store.setSetting("adminUserId", realAdminId);
  });
});

/** a config with only the field the origin list reads */
function configWithHost(host: string): Parameters<typeof authTrustedOrigins>[0] {
  // SAFETY: `authTrustedOrigins` reads `config.host` and nothing else, which is
  // the whole input this helper is about.
  return { host } as Parameters<typeof authTrustedOrigins>[0];
}

describe("authTrustedOrigins (#347)", () => {
  // the loopback gate is the whole safety property: a remote API must not gain an
  // origin because a dev variable happens to be set
  it("adds the dev origin only for a loopback API", () => {
    // BOTH loopback spellings: the dev webview loads `localhost` while the API
    // defaults to `127.0.0.1`, and a single spelling refused the desktop window
    expect(authTrustedOrigins(configWithHost("127.0.0.1"), { DOKAN_WEB_PORT: "5173" })).toEqual([
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
    expect(authTrustedOrigins(configWithHost("localhost"), { DOKAN_WEB_PORT: "5173" })).toEqual([
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
    // a remote API adds nothing, whatever the env says
    expect(authTrustedOrigins(configWithHost("10.0.0.5"), { DOKAN_WEB_PORT: "5173" })).toEqual([]);
  });

  it("keeps only absolute http(s) origins from the environment", () => {
    const configured = authTrustedOrigins(configWithHost("10.0.0.5"), {
      DOKAN_TRUSTED_ORIGINS: "https://shop.example, http://10.0.0.5:8080, not-a-url, ftp://x.example, javascript:alert(1)",
    });
    // a bare host, a non-http scheme and a URL that does not parse are all dropped:
    // a config mistake must not become a blanket allow
    expect(configured).toEqual(["https://shop.example", "http://10.0.0.5:8080"]);
  });

  it("keeps a configured origin AND the dev origin on a loopback API", () => {
    expect(
      authTrustedOrigins(configWithHost("127.0.0.1"), {
        DOKAN_TRUSTED_ORIGINS: "https://shop.example",
        DOKAN_WEB_PORT: "5471",
      }),
    ).toEqual(["https://shop.example", "http://127.0.0.1:5471", "http://localhost:5471"]);
  });
});
