import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  changeVaultPassphrase,
  fetchVaultStatus,
  isVaultPassphraseLongEnough,
  removeRecoveryKey,
  resetVaultPassphrase,
  revokeVaultSession,
  storeVaultSessionToken,
  VaultRequestError,
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
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

describe("vault credential calls return and adopt the rotated session token", () => {
  it("changeVaultPassphrase returns the fresh token", async () => {
    routes.set("/api/vault/change-passphrase", () => Response.json({ ok: true, sessionToken: "rotated-1" }));
    expect(await changeVaultPassphrase("old passphrase", "new passphrase")).toBe("rotated-1");
  });

  it("removeRecoveryKey returns the fresh token", async () => {
    routes.set("/api/vault/recovery-keys/abc", () => Response.json({ ok: true, sessionToken: "rotated-2" }));
    expect(await removeRecoveryKey("abc")).toBe("rotated-2");
  });

  it("resetVaultPassphrase sends the recovery key unauthenticated and returns the token", async () => {
    type ResetBody = { recoveryKey?: string; newPassphrase?: string };
    let body: ResetBody = {};
    let headers: Headers | undefined;
    routes.set("/api/vault/reset-passphrase", (init) => {
      // SAFETY: this test wrote the JSON body itself in the call under test
      body = JSON.parse(String(init?.body)) as ResetBody;
      headers = new Headers(init?.headers);
      return Response.json({ ok: true, sessionToken: "reset-token" });
    });
    const token = await resetVaultPassphrase("ABCD-EFGH", "a brand new passphrase");
    expect(token).toBe("reset-token");
    expect(body.recoveryKey).toBe("ABCD-EFGH");
    expect(headers?.get("x-vault-session")).toBeNull();
  });

  it("surfaces the server code and Arabic message on a refusal", async () => {
    routes.set("/api/vault/reset-passphrase", () =>
      Response.json({ error: { code: "VAULT_WRONG_RECOVERY", message: "مفتاح الاسترداد غير صحيح." } }, { status: 401 }),
    );
    try {
      await resetVaultPassphrase("bad", "a brand new passphrase");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultRequestError);
      if (error instanceof VaultRequestError) {
        expect(error.code).toBe("VAULT_WRONG_RECOVERY");
        expect(error.message).toContain("مفتاح الاسترداد");
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
});

describe("vault status and logout", () => {
  it("distinguishes a legacy build (404) from an unreachable server", async () => {
    await expect(fetchVaultStatus()).rejects.toMatchObject({ code: "VAULT_UNSUPPORTED" });
    routes.set("/api/vault/status", () => {
      throw new Error("api down");
    });
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
