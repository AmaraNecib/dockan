import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { createApp } from "../app";
import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppError } from "../lib/errors";
import { AppLogger } from "../lib/logger";
import { normalizeAlgerianPhone, phoneToUsername } from "../lib/phone";
import { createRpcRouter } from "../rpc/router";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { resetAdminPassword } from "./admin";
import { createAuth, type BetterAuthInstance } from "./auth";

const PHONE = "+213550123123";
const USERNAME = phoneToUsername(PHONE);
const PASSWORD = "dokan-1234";

// SAFETY: the oRPC client is typed by the contract; a narrow interface keeps
// the tests honest without dragging client type machinery in
type RpcApi = {
  authResetPassword(input: { secret: string; newPassword: string; phoneNumber: string }): Promise<{ ok: boolean }>;
  categoriesList(): Promise<never>; // the session-guard tests expect rejection
};

let dir: string;
let conn: Connection;
let store: StorePort;
let auth: BetterAuthInstance;
let app: ReturnType<typeof createApp>;
let config: ReturnType<typeof createAppConfig>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-auth-"));
  config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "test.db"),
    DOKAN_AUTH_SECRET: "test-auth-secret",
    DOKAN_BUILD_SECRET: "test-build-secret",
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  auth = createAuth(conn.db, config);
  const logger = new AppLogger(dir);
  app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });
});

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

async function resetVia(code: "reset-1234" | "rotated-4321" | "rpc-9999") {
  const passwords = { "reset-1234": PASSWORD, "rotated-4321": "rotated-4321", "rpc-9999": "rpc-9999" };
  await resetAdminPassword(
    { db: conn.db, auth, store, config, logger: new AppLogger(dir) },
    { secret: "test-build-secret", newPassword: passwords[code], phoneNumber: PHONE },
  );
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
});

  it("blocks account creation over http (single-admin boundary)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213699999999", password: "x", name: "x" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a session that is not the provisioned admin", async () => {
    await resetVia("reset-1234");
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
describe("resetAdminPassword", () => {
  it("refuses to provision when no build secret is configured (boot never crashes)", async () => {
    const unconfigured = createAppConfig({ DOKAN_DATA_DIR: dir });
    expect(unconfigured.buildSecret).toBeUndefined();
    let error: unknown;
    try {
      await resetAdminPassword(
        { db: conn.db, auth, store, config: unconfigured, logger: new AppLogger(dir) },
        { secret: "anything", newPassword: PASSWORD, phoneNumber: PHONE },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof AppError ? error.code : undefined).toBe("BUILD_SECRET_NOT_CONFIGURED");
  });

  it("rejects a wrong build secret with WRONG_BUILD_SECRET", async () => {
    let error: unknown;
    try {
      await resetAdminPassword(
        { db: conn.db, auth, store, config, logger: new AppLogger(dir) },
        { secret: "wrong", newPassword: PASSWORD, phoneNumber: PHONE },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error instanceof AppError ? error.code : undefined).toBe("WRONG_BUILD_SECRET");
  });

  it("rejects an invalid phone with INVALID_PHONE_NUMBER", async () => {
    let error: unknown;
    try {
      await resetAdminPassword(
        { db: conn.db, auth, store, config, logger: new AppLogger(dir) },
        { secret: "test-build-secret", newPassword: PASSWORD, phoneNumber: "123" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof AppError ? error.code : undefined).toBe("INVALID_PHONE_NUMBER");
  });

  it("provisions the admin, then sign-in works with the phone digits", async () => {
    await resetVia("reset-1234");
    const login = await signIn(USERNAME, PASSWORD);
    expect(login.status).toBe(200);
    // SAFETY: the sign-in response carries the user object whose username we asserted creates
    // SAFETY: a 200 sign-in response always carries the user object
    const body = (await login.json()) as { user: { username: string } };
    expect(body.user.username).toBe(USERNAME);
  });

  it("sign-in rejects wrong password and unknown phone alike", async () => {
    expect((await signIn(USERNAME, "wrong-pass")).status).toBe(401);
    expect((await signIn("213700000000", PASSWORD)).status).toBe(401);
  });

  it("rotates the password on the next reset", async () => {
    await resetVia("rotated-4321");
    expect((await signIn(USERNAME, PASSWORD)).status).toBe(401);
    expect((await signIn(USERNAME, "rotated-4321")).status).toBe(200);
  });

  it("records a PASSWORD_RESET activity", async () => {
    const acts = await store.listActivities(20);
    expect(acts.some((a) => a.type === "PASSWORD_RESET")).toBe(true);
  });
});

describe("rpc session guard", () => {

  it("rejects a guarded procedure without a session", async () => {
    const client = clientWith(async (request) => await app.fetch(request));
    // SAFETY: ORPCError exposes .code on rejection
    await expect(client.categoriesList()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("passes the guard with a session and hits the ticket-03 seam", async () => {
    const login = await signIn(USERNAME, "rotated-4321");
    const cookie = login.headers.get("set-cookie") ?? "";
    const client = clientWith(async (request) => {
      const headers = new Headers(request.headers);
      if (cookie !== "") headers.set("cookie", cookie);
      return await app.fetch(new Request(request, { headers }));
    });
    // SAFETY: reaching NOT_IMPLEMENTED proves the guard accepted the session
    await expect(client.categoriesList()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("resets the password through the rpc procedure", async () => {
    const client = clientWith(async (request) => await app.fetch(request));
    // SAFETY: procedure input is validated by the contract schema at the seam
    const out = await client.authResetPassword({ secret: "test-build-secret", newPassword: "rpc-9999", phoneNumber: PHONE });
    expect(out.ok).toBe(true);
    expect((await signIn(USERNAME, "rpc-9999")).status).toBe(200);
  });
});