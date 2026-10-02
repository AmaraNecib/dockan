import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { logoutAndReload } from "./logout";
import { clearVaultSessionToken, readVaultSessionToken, storeVaultSessionToken } from "./vault-client";

let reloads = 0;
let revokeCalls = 0;
let revokeHeaders: string | null = null;
const originalReload = window.location.reload;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  reloads = 0;
  revokeCalls = 0;
  revokeHeaders = null;
  window.sessionStorage.clear();
  // happy-dom does not implement navigation; count the calls instead
  Object.defineProperty(window.location, "reload", {
    configurable: true,
    value: () => {
      reloads += 1;
    },
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, "http://localhost").pathname === "/api/vault/logout") {
        revokeCalls += 1;
        revokeHeaders = new Headers(init?.headers).get("x-vault-session");
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
  globalThis.fetch = originalFetch;
  clearVaultSessionToken();
  // SAFETY: the broker test installed this exact optional global above
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("logoutAndReload", () => {
  it("revokes the server session, clears the local token, and reloads", async () => {
    storeVaultSessionToken("vault-session-token");
    expect(readVaultSessionToken()).toBe("vault-session-token");

    let tokenWhenSignOutRan: string | undefined = "unset";
    await logoutAndReload(async () => {
      tokenWhenSignOutRan = readVaultSessionToken();
      return null;
    });

    // the server was told to revoke with the live token, before it was dropped
    expect(revokeCalls).toBe(1);
    expect(revokeHeaders).toBe("vault-session-token");
    expect(tokenWhenSignOutRan).toBeUndefined();
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
  });

  it("still clears and reloads when the revoke and sign-out fail", async () => {
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        throw new Error("network down");
      },
      { preconnect: originalFetch.preconnect },
    );
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => {
      throw new Error("network down");
    });
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
  });

  it("restarts the broker sidecar before the reload so the gate can unlock again (round-2 finding 1)", async () => {
    const commands: string[] = [];
    // SAFETY: the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<null> } }).__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        commands.push(command);
        return null;
      },
    };
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => null);
    // the pipe is reset before the reload lands on the gate
    expect(commands).toEqual(["vault_logout"]);
    expect(revokeCalls).toBe(1);
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
  });
});
