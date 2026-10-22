import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { logoutAndReload } from "./logout";
import { SIGNED_OUT_STORAGE_KEY, authLossReason, clearAuthLost, recoverAuthLost } from "./auth-refusal";
import { clearVaultSessionToken, readVaultSessionToken, storeVaultSessionToken } from "./vault-client";

let reloads = 0;
let revokeCalls = 0;
let revokeHeaders: string | null = null;
const originalReload = window.location.reload;
const originalFetch = globalThis.fetch;

/** A locked vault build's status body, as the status route answers it. */
const vaultStatusBody = {
  mode: "vault",
  state: "locked",
  legacyDatabase: false,
  recoveryKeyCount: 0,
  lockedForMs: 0,
  unlocked: false,
  session: false,
  broker: false,
} as const;

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
  clearAuthLost();
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

  it("does NOT reload when the revoke failed: the cookie would walk back in (#319 review)", async () => {
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
    // the local copy is gone, but the page cannot disable an HttpOnly cookie,
    // and the server never confirmed the revoke: a reload here lands back in
    // the app without a passphrase on a shared machine
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(0);
    // the unlock screen is the answer instead, and it is its own reason: a
    // live cookie must not undo it
    expect(authLossReason()).toBe("signed-out");
    recoverAuthLost();
    expect(authLossReason()).toBe("signed-out");
    // an unlock is the owner's own action and DOES clear it
    clearAuthLost();
    expect(authLossReason()).toBeUndefined();
  });

  it("reloads when this build has no vault route at all (round-4 P1)", async () => {
    // DOKAN_VAULT=disabled: /api/vault/logout is not mounted, so the revoke
    // answers 404 — and since round 5 the status route has to agree before that
    // 404 is read as absence (#319 round 5). No vault session exists, which
    // makes the local clear the WHOLE credential; holding the page here left
    // the legacy app mounted after a sign-out that had succeeded.
    globalThis.fetch = Object.assign(async (): Promise<Response> => new Response("not found", { status: 404 }), {
      preconnect: originalFetch.preconnect,
    });
    storeVaultSessionToken("vault-session-token");
    let signedOut = false;
    await logoutAndReload(async () => {
      signedOut = true;
      return null;
    });
    expect(signedOut).toBe(true);
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
    // nothing held the page: there is no server credential left to walk back in
    expect(authLossReason()).toBeUndefined();
  });

  it("holds the page when a 404 on the logout route is not the whole build (round 5)", async () => {
    // `VAULT_UNSUPPORTED` is not a statement, it is a GUESS: "a 404 whose body
    // carried no envelope". Any hop that never forwards the route — a proxy, a
    // renamed route, a gateway answering `{}`/`null`/HTML — looks identical,
    // and `absent` RELOADS. With a live cookie that walks the owner straight
    // back into the app, which is the round-4 defect re-entered through a
    // guess. So the guess is checked against the build itself: a mounted vault
    // build answers `mode: "vault"` on the status route, and an absent logout
    // there is unconfirmed.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
        if (path === "/api/vault/logout") return new Response("<html>not found</html>", { status: 404 });
        if (path === "/api/vault/status") return Response.json(vaultStatusBody);
        return new Response("not found", { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => null);
    // no reload: the cookie may still be live, so the unlock screen holds
    expect(reloads).toBe(0);
    expect(authLossReason()).toBe("signed-out");
  });

  it("reloads when the page has no vault route to walk back into, whatever the logout answered (round 5)", async () => {
    // The plaintext build again, with a revoke that failed for a reason that is
    // NOT "no such route": a 5xx from a proxy, a 200 whose body is not an
    // envelope. There is no vault cookie in this build, so the hold protects
    // nothing — and holding is not a neutral no-op: `authLost` was read only
    // inside the vault branch, so the signed-in app stayed mounted with nothing
    // reloading, which is verbatim the round-4 symptom (round-5 P3). The
    // credential on this build is the better-auth session, and `signOut` has
    // already run, so asking the server again is the answer.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
        if (path === "/api/vault/logout") return new Response("gateway error", { status: 502 });
        return new Response("not found", { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    let signedOut = false;
    await logoutAndReload(async () => {
      signedOut = true;
      return null;
    });
    expect(signedOut).toBe(true);
    expect(reloads).toBe(1);
    // and nothing is remembered: a flag here would be inert on this build, and
    // on a machine that later runs a vault build it would hold the gate for no
    // reason the owner could explain
    expect(authLossReason()).toBeUndefined();
  });

  it("reloads when the vault has no session to revoke (round-4 P1)", async () => {
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => Response.json({ error: { code: "VAULT_NOT_UNLOCKED" } }, { status: 401 }),
      { preconnect: originalFetch.preconnect },
    );
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => null);
    expect(reloads).toBe(1);
    expect(authLossReason()).toBeUndefined();
  });

  it("remembers the unconfirmed sign-out across a reload, and remembers nothing else (round-4 P1)", async () => {
    // the revoke fails, so the HttpOnly cookie is still live; without a flag
    // that survives the page, the reload asks the status route — which reads
    // that cookie — and mounts the app (round-4 P1)
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        throw new Error("network down");
      },
      { preconnect: originalFetch.preconnect },
    );
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => null);
    expect(authLossReason()).toBe("signed-out");

    // what a FRESH PAGE finds: the flag alone puts the unlock screen up, with
    // no markSignedOut call and no memory of this page — which is the reload
    expect(window.localStorage.getItem(SIGNED_OUT_STORAGE_KEY)).toBe("1");
    // ... and it is a flag, never a credential: one byte, no token, no
    // generation, and nothing that could be replayed to the server
    expect(Object.keys(window.localStorage)).toEqual([SIGNED_OUT_STORAGE_KEY]);
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();

    // the owner's unlock is the one thing that ends it, and it ends it for good
    clearAuthLost();
    expect(window.localStorage.getItem(SIGNED_OUT_STORAGE_KEY)).toBeNull();
    expect(authLossReason()).toBeUndefined();
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
