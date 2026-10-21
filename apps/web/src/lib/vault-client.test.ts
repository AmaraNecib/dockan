import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  changeVaultPassphrase,
  clearVaultSessionToken,
  fetchVaultStatus,
  isVaultPassphraseLongEnough,
  readVaultSessionToken,
  removeRecoveryKey,
  resetVaultPassphrase,
  revokeVaultSession,
  storeVaultSessionToken,
  VaultRequestError,
  vaultErrorCopy,
  vaultSetup,
  vaultUnlock,
  vaultUnlockWithRecovery,
} from "./vault-client";

let routes = new Map<string, (init: RequestInit | undefined) => Response>();
const originalFetch = globalThis.fetch;
const mockFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, "http://localhost").pathname;
    const handler = routes.get(path);
    if (handler === undefined) return new Response("not found", { status: 404 });
    return handler(init);
  },
  { preconnect: originalFetch.preconnect },
);

beforeEach(() => {
  routes = new Map();
  globalThis.fetch = mockFetch;
  window.sessionStorage.clear();
  // the page's memory is the only place a token can live now (#319), so a
  // test starts from a page that has never held one
  clearVaultSessionToken();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
  clearVaultSessionToken();
  // SAFETY: the broker test installs this exact optional global
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("vault passphrase validation", () => {
  it("rejects whitespace-only and padded-short passphrases on the NORMALIZED value", () => {
    expect(isVaultPassphraseLongEnough("        ")).toBe(false);
    expect(isVaultPassphraseLongEnough("  short  ")).toBe(false);
    expect(isVaultPassphraseLongEnough("1234567 ")).toBe(false);
    expect(isVaultPassphraseLongEnough("12345678")).toBe(true);
    expect(isVaultPassphraseLongEnough(" 12345678 ")).toBe(true);
  });
});

describe("vault credential calls adopt the rotated session token the broker path returns", () => {
  it("changeVaultPassphrase adopts the fresh token", async () => {
    routes.set("/api/vault/change-passphrase", () => Response.json({ ok: true, sessionToken: "rotated-1" }));
    await changeVaultPassphrase("old passphrase", "new passphrase");
    expect(readVaultSessionToken()).toBe("rotated-1");
  });

  it("removeRecoveryKey adopts the fresh token", async () => {
    routes.set("/api/vault/recovery-keys/abc", () => Response.json({ ok: true, sessionToken: "rotated-2" }));
    await removeRecoveryKey("abc");
    expect(readVaultSessionToken()).toBe("rotated-2");
  });

  it("resetVaultPassphrase sends the recovery key unauthenticated and adopts the token", async () => {
    type ResetBody = { recoveryKey?: string; newPassphrase?: string };
    let body: ResetBody = {};
    let headers: Headers | undefined;
    routes.set("/api/vault/reset-passphrase", (init) => {
      // SAFETY: this test wrote the JSON body itself in the call under test
      body = JSON.parse(String(init?.body)) as ResetBody;
      headers = new Headers(init?.headers);
      return Response.json({ ok: true, sessionToken: "reset-token" });
    });
    await resetVaultPassphrase("ABCD-EFGH", "a brand new passphrase");
    expect(readVaultSessionToken()).toBe("reset-token");
    expect(body.recoveryKey).toBe("ABCD-EFGH");
    expect(headers?.get("x-vault-session")).toBeNull();
  });

  it("surfaces the server code and ignores any server-side copy (round-6)", async () => {
    routes.set("/api/vault/reset-passphrase", () =>
      // an OLD server may still send a message; the web must not render it
      Response.json({ error: { code: "VAULT_WRONG_RECOVERY", message: "نص من الخادم" } }, { status: 401 }),
    );
    try {
      await resetVaultPassphrase("bad", "a brand new passphrase");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultRequestError);
      if (error instanceof VaultRequestError) {
        expect(error.code).toBe("VAULT_WRONG_RECOVERY");
        // the API is locale-neutral; the web owns the copy via i18n
        expect(error.message).toBe("VAULT_WRONG_RECOVERY");
        expect(vaultErrorCopy(error)).toContain("مفتاح الاسترداد");
      }
    }
  });

  it("translates a code-only refusal with no server message (round-6)", async () => {
    routes.set("/api/vault/reset-passphrase", () => Response.json({ error: { code: "VAULT_PASSPHRASE_TOO_SHORT" } }, { status: 400 }));
    try {
      await resetVaultPassphrase("bad", "short");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultRequestError);
      if (error instanceof VaultRequestError) {
        expect(error.code).toBe("VAULT_PASSPHRASE_TOO_SHORT");
        expect(vaultErrorCopy(error)).not.toBe("VAULT_PASSPHRASE_TOO_SHORT");
        expect(vaultErrorCopy(error)).toMatch(/[\u0600-\u06FF]/);
      }
    }
  });

  it("attaches the stored vault session to authenticated mutations", async () => {
    storeVaultSessionToken("stored-token");
    type SeenHeader = { value: string | null };
    const seen: SeenHeader = { value: null };
    routes.set("/api/vault/change-passphrase", (init) => {
      seen.value = new Headers(init?.headers).get("x-vault-session");
      return Response.json({ ok: true, sessionToken: "rotated-3" });
    });
    await changeVaultPassphrase("old passphrase", "new passphrase");
    expect(seen.value).toBe("stored-token");
  });

  it("keeps the newest session when an older rotation response arrives late (round-7 finding 5)", async () => {
    // the server records generations; a late response with a smaller one must
    // never revive the token it revoked
    storeVaultSessionToken("newer-token", 7);
    storeVaultSessionToken("older-token", 3);
    expect(readVaultSessionToken()).toBe("newer-token");
    storeVaultSessionToken("newest-token", 9);
    expect(readVaultSessionToken()).toBe("newest-token");
  });

  it("adopts the rotation generation returned by the server", async () => {
    routes.set("/api/vault/change-passphrase", () => Response.json({ ok: true, sessionToken: "rotated-5", sessionGeneration: 5 }));
    await changeVaultPassphrase("old passphrase", "new passphrase");
    expect(readVaultSessionToken()).toBe("rotated-5");
    // a slower response from an earlier rotation cannot clobber it
    storeVaultSessionToken("rotated-2", 2);
    expect(readVaultSessionToken()).toBe("rotated-5");
  });
});

describe("the browser path keeps the session out of JavaScript (#319)", () => {
  it("holds nothing from an unlock reply that carried no token", async () => {
    routes.set("/api/vault/unlock", () => Response.json({ ok: true, sessionGeneration: 3 }));
    await vaultUnlock("correct horse battery");
    // the credential is the HttpOnly cookie the reply set: nothing to hold
    expect(readVaultSessionToken()).toBeUndefined();
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBeNull();
  });

  it("holds no setup or unlock token in web storage at all", async () => {
    routes.set("/api/vault/setup", () =>
      Response.json({ ok: true, recoveryKey: "ABCD-EFGH", plaintextStatus: "clean", plaintextRemaining: [] }),
    );
    const setup = await vaultSetup("correct horse battery");
    expect(setup.recoveryKey).toBe("ABCD-EFGH");
    routes.set("/api/vault/unlock-recovery", () => Response.json({ ok: true, sessionGeneration: 4 }));
    await vaultUnlockWithRecovery("ABCD-EFGH-IJKL");
    // a token in storage is a token a page can steal: there is none on any
    // path, including the generation the client used to track (round-7)
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBeNull();
    expect(readVaultSessionToken()).toBeUndefined();
  });

  it("still adopts the token a broker-mode HTTP reply carries, in memory only", async () => {
    // the post-unlock credential routes stay HTTP in broker mode, so their
    // reply is the one place a browser-path build can see a body token
    routes.set("/api/vault/change-passphrase", () => Response.json({ ok: true, sessionToken: "rotated-9" }));
    await changeVaultPassphrase("old passphrase", "new passphrase");
    expect(readVaultSessionToken()).toBe("rotated-9");
    // memory, never storage
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();
  });
});

describe("the broker path keeps its token across a webview reload (#319 review P2)", () => {
  /** Install the bridge the packaged desktop's webview injects. */
  function installBroker(): void {
    // SAFETY: the global Tauri injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: { invoke: () => Promise<null> } }).__TAURI_INTERNALS__ = {
      invoke: async () => null,
    };
  }

  it("persists the token and its generation, so a reload does not demand the passphrase again", () => {
    installBroker();
    storeVaultSessionToken("broker-token", 4);
    expect(readVaultSessionToken()).toBe("broker-token");
    // the reload's guarantee: the secret that signs the RPC calls survives
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBe("broker-token");
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBe("4");
    // and the generation moved with it, so an older reply still cannot revive
    storeVaultSessionToken("older-token", 3);
    expect(readVaultSessionToken()).toBe("broker-token");
    clearVaultSessionToken();
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBeNull();
  });

  it("still holds nothing on the browser path, where the cookie is the credential", () => {
    // no bridge: this is a plain browser, and a token in storage would be a
    // token any script on the page could steal
    storeVaultSessionToken("should-not-persist", 1);
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBeNull();
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBeNull();
    // the in-memory copy still signs this page's calls (the header fallback)
    expect(readVaultSessionToken()).toBe("should-not-persist");
  });

  /**
   * The browser-path guarantee with a token ALREADY planted (#319 round 3,
   * test-audit P1). The tests above never wrote a token, so "there is nothing in
   * storage" was true because nothing had put one there — deleting
   * `brokerStorage()`'s `brokerAvailable()` guard left them all green. This one
   * plants the exact key a Tauri build would have written and requires the
   * browser path to ignore it twice over: it never becomes this page's
   * credential, and the value is left exactly as it was found.
   */
  it("ignores a token already in storage when this is a plain browser", () => {
    // SAFETY: no `__TAURI_INTERNALS__` is the browser path; the delete in
    // afterEach keeps that true for the next test
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.sessionStorage.setItem("dokan.vault.session", "planted-token");
    window.sessionStorage.setItem("dokan.vault.session-generation", "7");

    // not adopted: a page that cannot be trusted with a token must not borrow one
    expect(readVaultSessionToken()).toBeUndefined();
    // and not "cleaned up" either: a read is a read, and the path that may not
    // write must not write
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBe("planted-token");
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBe("7");

    // storing a newer generation does not rewrite the planted one either
    storeVaultSessionToken("browser-token", 9);
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBe("planted-token");
    expect(window.sessionStorage.getItem("dokan.vault.session-generation")).toBe("7");
    // the token this page holds is its own, in memory only
    expect(readVaultSessionToken()).toBe("browser-token");
  });
});

describe("vault status and logout", () => {
  it("distinguishes a legacy build (404) from an unreachable server", async () => {
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_UNSUPPORTED" });
    routes.set("/api/vault/status", () => {
      throw new Error("api down");
    });
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_UNREACHABLE" });
  });

  it("keeps the code of a named refusal instead of calling it unreachable (#276)", async () => {
    // the other-instance lock answers this route with 503 + the stable code (#275)
    routes.set("/api/vault/status", () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 }));
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
  });

  it("carries the lock refusal's recycled-pid discriminator (#283)", async () => {
    routes.set(
      "/api/vault/status",
      () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } }, { status: 503 }),
    );
    await expect(fetchVaultStatus()).rejects.toMatchObject({
      code: "VAULT_LOCKED_BY_OTHER_INSTANCE",
      staleHeartbeat: true,
    });
    // an unflagged refusal reads false, so the gate keeps #276's copy
    routes.set("/api/vault/status", () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 }));
    await expect(fetchVaultStatus()).rejects.toMatchObject({ staleHeartbeat: false });
  });

  it("reads an HTML refusal page and a code-less 5xx as unreachable, never as a named cause (#276)", async () => {
    // a build older than #275 answers the route with the Arabic refusal page
    routes.set(
      "/api/vault/status",
      () => new Response("<!doctype html><main>البيانات مفتوحة في نسخة أخرى</main>", { status: 503, headers: { "content-type": "text/html" } }),
    );
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_UNREACHABLE" });

    // a proxy error body is not an error envelope either
    routes.set("/api/vault/status", () => Response.json({ error: "bad gateway" }, { status: 502 }));
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_UNREACHABLE" });
  });

  it("revokeVaultSession posts with the stored token", async () => {
    storeVaultSessionToken("session-tok");
    const seen = { value: "" };
    routes.set("/api/vault/logout", (init) => {
      seen.value = new Headers(init?.headers).get("x-vault-session") ?? "";
      return Response.json({ ok: true });
    });
    await revokeVaultSession();
    expect(seen.value).toBe("session-tok");
  });
});
