import { describe, expect, it } from "bun:test";

import {
  clearedVaultSessionCookie,
  readVaultSessionCookie,
  resolveVaultCredential,
  vaultOriginGate,
  vaultSessionCookie,
  vaultSessionPayload,
} from "./session";

/**
 * The vault session's two transports (#319), as pure rules, plus the one origin
 * gate.
 *
 * The end-to-end behaviour is pinned over the real gate in `gate.test.ts`; this
 * file pins the parts a route test cannot see cheaply — every cookie attribute,
 * which transport a server of a given mode reads a credential from, and the
 * origin comparison that the browser cookie rides on.
 *
 * Every test here is waived on the parent, because the module under test
 * (`./session`) is INTRODUCED by this change: the parent cannot load this file,
 * so no run of it there can be red for the right reason. The discrimination is
 * a mutation proof instead — each source rule reverted in turn, the named test
 * watched failing, the source restored (the lane report carries the commands).
 */

// red-on-parent-waive: 'vault session cookie' — the module under test (./session) is introduced by this change; discrimination is the mutation proof, not a parent run
// red-on-parent-waive: 'reply a minting route returns' — the module under test (./session) is introduced by this change; discrimination is the mutation proof, not a parent run
// red-on-parent-waive: 'which transport a request presents' — the module under test (./session) is introduced by this change; discrimination is the mutation proof, not a parent run
// red-on-parent-waive: 'one origin gate' — the module under test (./session) is introduced by this change; discrimination is the mutation proof, not a parent run
// red-on-parent-waive: 'reads the vault cookie out of a jar' — the module under test (./session) is introduced by this change; discrimination is the mutation proof, not a parent run

/** A request as the gate or the RPC guard would see it. */
function requestAt(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

/** The app served over HTTPS: the only case where the cookie is Secure anyway. */
const SECURE_APP = "https://dokan.example/api/vault/unlock";
/** The app on a loopback address, which is a secure context over plain HTTP. */
const ADDRESS_APP = "http://127.0.0.1:4399/api/vault/unlock";
/** The app on a hostname that is neither HTTPS nor loopback. */
const PLAIN_APP = "http://shop.example/api/vault/unlock";

describe("the vault session cookie's attributes (#319)", () => {
  /**
   * The WHOLE string, not one `toContain` per attribute. Piecemeal assertions
   * let an extra attribute through: `Max-Age=604800` added to `cookieAttributes`
   * would turn a browser-session credential into a week-long one on a shared
   * machine and leave every test green (test-audit lens, round 2).
   */
  it("is exactly HttpOnly, SameSite=Strict, Path=/ and host-only", () => {
    expect(vaultSessionCookie(requestAt(PLAIN_APP), "TOKEN")).toBe(
      "dokan.vault.session=TOKEN; HttpOnly; SameSite=Strict; Path=/",
    );
  });

  it("adds Secure on HTTPS and on a loopback origin over plain HTTP", () => {
    // a localhost host is a secure context, so both engines accept Secure here
    expect(vaultSessionCookie(requestAt(SECURE_APP), "TOKEN")).toBe(
      "dokan.vault.session=TOKEN; HttpOnly; SameSite=Strict; Path=/; Secure",
    );
    expect(vaultSessionCookie(requestAt(ADDRESS_APP), "TOKEN")).toBe(
      "dokan.vault.session=TOKEN; HttpOnly; SameSite=Strict; Path=/; Secure",
    );
    expect(vaultSessionCookie(requestAt("http://localhost:5173/api/vault/unlock"), "TOKEN")).toContain("; Secure");
  });

  it("clears with Max-Age=0 and the same attributes", () => {
    // the exact string: a cleared cookie that lost an attribute or gained a
    // lifetime is a cookie that does not go away
    expect(clearedVaultSessionCookie(requestAt(ADDRESS_APP))).toBe(
      "dokan.vault.session=; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=0",
    );
    expect(clearedVaultSessionCookie(requestAt(PLAIN_APP))).toBe(
      "dokan.vault.session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
  });

  it("reads the vault cookie out of a jar and ignores the neighbours", () => {
    const request = requestAt(ADDRESS_APP, {
      headers: { cookie: "other=1; dokan.vault.session=TOKEN; another=2" },
    });
    expect(readVaultSessionCookie(request)).toBe("TOKEN");
    // no vault cookie is not an empty token
    expect(readVaultSessionCookie(requestAt(ADDRESS_APP, { headers: { cookie: "other=1" } }))).toBeUndefined();
    expect(readVaultSessionCookie(requestAt(ADDRESS_APP, { headers: { cookie: "dokan.vault.session=" } }))).toBeUndefined();
  });
});

describe("the reply a minting route returns (#319)", () => {
  it("hands a browser the cookie and never the token in the body", () => {
    const payload = vaultSessionPayload(false, requestAt(ADDRESS_APP), "TOKEN", 7);
    expect(payload.body.sessionToken).toBeUndefined();
    expect(payload.body.sessionGeneration).toBe(7);
    expect(payload.headers["set-cookie"]).toContain("dokan.vault.session=TOKEN");
    expect(payload.headers["set-cookie"]).toContain("HttpOnly");
  });

  it("hands the broker the token in the body and sets no cookie", () => {
    const payload = vaultSessionPayload(true, requestAt(ADDRESS_APP), "TOKEN", 7);
    expect(payload.body.sessionToken).toBe("TOKEN");
    expect(payload.body.sessionGeneration).toBe(7);
    expect(payload.headers).toEqual({});
  });
});

describe("which transport a request presents (#319)", () => {
  const browserMode = { broker: false };
  const brokerMode = { broker: true };

  it("reads the cookie on the browser path", () => {
    const request = requestAt(ADDRESS_APP, { headers: { cookie: "dokan.vault.session=TOKEN" } });
    expect(resolveVaultCredential(request, browserMode)).toEqual({
      kind: "credential",
      token: "TOKEN",
      carrier: "cookie",
    });
  });

  it("keeps reading the header on the browser path, for the clients that hold a token", () => {
    const request = requestAt(ADDRESS_APP, { headers: { "x-vault-session": "TOKEN" } });
    expect(resolveVaultCredential(request, browserMode)).toEqual({
      kind: "credential",
      token: "TOKEN",
      carrier: "header",
    });
  });

  it("reads only the header on the broker path: a cookie is not a credential there", () => {
    const cookieOnly = requestAt(ADDRESS_APP, { headers: { cookie: "dokan.vault.session=TOKEN" } });
    expect(resolveVaultCredential(cookieOnly, brokerMode)).toEqual({ kind: "none" });
    const header = requestAt(ADDRESS_APP, { headers: { "x-vault-session": "TOKEN" } });
    expect(resolveVaultCredential(header, brokerMode)).toEqual({
      kind: "credential",
      token: "TOKEN",
      carrier: "header",
    });
  });

  it("prefers the cookie over the header on the browser path", () => {
    const both = requestAt(ADDRESS_APP, {
      headers: { cookie: "dokan.vault.session=FROM-COOKIE", "x-vault-session": "FROM-HEADER" },
    });
    expect(resolveVaultCredential(both, browserMode)).toEqual({
      kind: "credential",
      token: "FROM-COOKIE",
      carrier: "cookie",
    });
  });

  it("refuses the cookie from an origin that is not the app's own", () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:9999", "http://localhost:9999", "null"]) {
      const request = requestAt(ADDRESS_APP, {
        headers: { cookie: "dokan.vault.session=TOKEN", origin },
      });
      expect(resolveVaultCredential(request, browserMode), origin).toEqual({ kind: "refused", reason: "foreign-origin" });
    }
  });

  it("accepts the cookie from its own origin, and from a request that sent none", () => {
    const own = requestAt(ADDRESS_APP, {
      headers: { cookie: "dokan.vault.session=TOKEN", origin: "http://127.0.0.1:4399" },
    });
    expect(resolveVaultCredential(own, browserMode).kind).toBe("credential");
    // a browser omits Origin on a GET, and SameSite=Strict is what keeps a
    // cross-site request from carrying the cookie at all
    const noOrigin = requestAt(ADDRESS_APP, { headers: { cookie: "dokan.vault.session=TOKEN" } });
    expect(resolveVaultCredential(noOrigin, browserMode).kind).toBe("credential");
  });

  it("carries nothing when the request carries neither credential", () => {
    expect(resolveVaultCredential(requestAt(ADDRESS_APP), browserMode)).toEqual({ kind: "none" });
    expect(resolveVaultCredential(requestAt(ADDRESS_APP), brokerMode)).toEqual({ kind: "none" });
  });
});

describe("the one origin gate (#319, greptile P1)", () => {
  const browserMode = { broker: false };
  const brokerMode = { broker: true };
  const AT = "http://127.0.0.1:4399/api/rpc/itemsList";

  it("accepts only the origin this request was addressed to", () => {
    const at = (origin: string): ReturnType<typeof vaultOriginGate> =>
      vaultOriginGate(requestAt(AT, { headers: { origin } }), browserMode);
    expect(at("http://127.0.0.1:4399")).toBe("same-origin");
    // A DIFFERENT PORT ON THE SAME HOST is a different origin. This is the case
    // the old loopback rule missed and the old test could not see: cookies
    // ignore ports and SameSite is scoped by site, so any other local dev
    // server was same-site with the API and its `Origin` passed.
    expect(at("http://127.0.0.1:9999")).toBe("foreign-origin");
    expect(at("http://localhost:9999")).toBe("foreign-origin");
    expect(at("http://evil.localhost:7777")).toBe("foreign-origin");
    expect(at("https://evil.example")).toBe("foreign-origin");
  });

  it("judges the host the client addressed, not a header the client chose", () => {
    // a TLS-terminating proxy in front of a plain-HTTP api: the scheme is not
    // compared, because host:port equality already pins the origin to this app
    expect(
      vaultOriginGate(requestAt("https://dokan.example/api/rpc/itemsList", { headers: { origin: "http://dokan.example" } }), browserMode),
    ).toBe("same-origin");
    // `x-forwarded-host` is caller-chosen, so it must never be the thing the
    // origin is compared against
    const spoof = requestAt(AT, {
      headers: { origin: "http://attacker.example", "x-forwarded-host": "attacker.example" },
    });
    expect(vaultOriginGate(spoof, browserMode)).toBe("foreign-origin");
  });

  it("accepts an absent Origin, and broker mode always", () => {
    expect(vaultOriginGate(requestAt(AT), browserMode)).toBe("same-origin");
    // the desktop webview's scheme is not an http origin and the shell is the
    // trusted party: it presents the header, not an ambient cookie
    expect(vaultOriginGate(requestAt(AT, { headers: { origin: "tauri://localhost" } }), brokerMode)).toBe("same-origin");
  });

  it("refuses a sandboxed frame's null origin and a non-http scheme", () => {
    for (const origin of ["null", "tauri://localhost", "file:///c:/dokan/index.html", "not a url"]) {
      expect(vaultOriginGate(requestAt(AT, { headers: { origin } }), browserMode), origin).toBe("foreign-origin");
    }
  });
});
