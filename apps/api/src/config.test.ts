import { describe, expect, it } from "bun:test";

import { createAppConfig } from "./config";

/**
 * Ticket 15: the desktop bootstrap hands the api its app-data and resource
 * dirs through env. These fields must stay readable and degrade to today's
 * dev behavior when unset.
 */
describe("createAppConfig packaged-build overrides", () => {
  // Windows path semantics (drive letters, backslashes) only hold on Windows:
  // on Linux `path.resolve("C:\\...")` is relative and lands under cwd, so this
  // assertion is Windows-only. The deferred Windows/desktop CI (#128)
  // exercises it on a real Windows host.
  it.skipIf(process.platform !== "win32")("reads DOKAN_WEB_DIST as an absolute path", () => {
    const config = createAppConfig({ DOKAN_WEB_DIST: "C:\\Program Files\\Dokan\\ui" });
    expect(config.webDataDir).toBe("C:\\Program Files\\Dokan\\ui");
  });

  // Windows-only, same reason as the guard above (#128 runs it on Windows).
  it.skipIf(process.platform !== "win32")("reads DOKAN_PORT_ROOT as an absolute path", () => {
    const config = createAppConfig({ DOKAN_PORT_ROOT: "C:\\Dokan\\run" });
    expect(config.portRecordDir).toBe("C:\\Dokan\\run");
  });

  it("reads DOKAN_BOOT_TOKEN verbatim", () => {
    const config = createAppConfig({ DOKAN_BOOT_TOKEN: "0123456789abcdef0123456789abcdef" });
    expect(config.bootToken).toBe("0123456789abcdef0123456789abcdef");
  });

  it("stays undefined when unset (dev/e2e behavior unchanged)", () => {
    const config = createAppConfig({});
    expect(config.webDataDir).toBeUndefined();
    expect(config.portRecordDir).toBeUndefined();
    expect(config.bootToken).toBeUndefined();
  });

  it("treats empty strings as unset", () => {
    const config = createAppConfig({ DOKAN_WEB_DIST: "", DOKAN_PORT_ROOT: "", DOKAN_BOOT_TOKEN: "" });
    expect(config.webDataDir).toBeUndefined();
    expect(config.portRecordDir).toBeUndefined();
    expect(config.bootToken).toBeUndefined();
  });

  it("does not disturb existing fields", () => {
    const config = createAppConfig({ DOKAN_DATA_DIR: "C:\\dokan\\data", DOKAN_PORT: "4321" });
    expect(config.dataDir).toBe("C:\\dokan\\data");
    expect(config.port).toBe(4321);
    expect(config.portExplicit).toBe(true);
    expect(config.webDataDir).toBeUndefined();
  });
});

describe("createAppConfig host binding", () => {
  it("defaults to loopback", () => {
    const config = createAppConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.probeHost).toBe("127.0.0.1");
  });

  it("treats a blank DOKAN_HOST as unset (empty string binds every interface on some runtimes)", () => {
    expect(createAppConfig({ DOKAN_HOST: "" }).host).toBe("127.0.0.1");
    expect(createAppConfig({ DOKAN_HOST: "   " }).host).toBe("127.0.0.1");
  });

  it("keeps an explicit LAN host without extra opt-in", () => {
    const config = createAppConfig({ DOKAN_HOST: "192.168.1.5" });
    expect(config.host).toBe("192.168.1.5");
    expect(config.probeHost).toBe("192.168.1.5");
  });

  it("accepts specific IPv6 hosts without any opt-in (regression: never wildcard)", () => {
    for (const host of ["ffff::", "::ffff", "::1", "2001:db8::1"]) {
      const config = createAppConfig({ DOKAN_HOST: host });
      expect(config.host).toBe(host);
      expect(config.probeHost).toBe(host);
    }
  });

  it("refuses a wildcard host unless DOKAN_HOST_INTERFACE opts in (fail loudly)", () => {
    let error: unknown;
    try {
      createAppConfig({ DOKAN_HOST: "0.0.0.0" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("DOKAN_HOST");
    expect(message).toContain("DOKAN_HOST_INTERFACE");
  });

  it("refuses every wildcard spelling without the opt-in", () => {
    const spellings = [
      "0.0.0.0",
      "::",
      "::0",
      "0:0:0:0:0:0:0:0",
      "0:0::",
      "0000:0000:0000:0000:0000:0000:0000:0000",
      "::ffff:0.0.0.0",
      "::ffff:0:0",
      "0:0:0:0:0:ffff:0:0",
      "::0.0.0.0",
    ];
    for (const host of spellings) {
      expect(() => createAppConfig({ DOKAN_HOST: host })).toThrow();
    }
  });

  it("accepts the wildcard when the opt-in env names the same interface", () => {
    const config = createAppConfig({ DOKAN_HOST: "0.0.0.0", DOKAN_HOST_INTERFACE: "0.0.0.0" });
    expect(config.host).toBe("0.0.0.0");
    // the liveness probe still CONNECTs to loopback for a wildcard bind
    expect(config.probeHost).toBe("127.0.0.1");
  });

  it("accepts the ipv6 wildcard only with the matching opt-in value", () => {
    expect(() => createAppConfig({ DOKAN_HOST: "::", DOKAN_HOST_INTERFACE: "0.0.0.0" })).toThrow();
    // an alternate zero-spelling still needs ITS OWN matching opt-in
    expect(() => createAppConfig({ DOKAN_HOST: "0:0::", DOKAN_HOST_INTERFACE: "::" })).toThrow();
    const config = createAppConfig({ DOKAN_HOST: "0:0::", DOKAN_HOST_INTERFACE: "0:0::" });
    expect(config.host).toBe("0:0::");
    expect(config.probeHost).toBe("127.0.0.1");
  });
});
describe("vault opt-out policy (finding D12)", () => {
  it("keeps the vault on by default", () => {
    const config = createAppConfig({});
    expect(config.vault).toBe("on");
    expect(config.vaultOptOutIgnored).toBe(false);
  });

  it("honours DOKAN_VAULT=disabled only outside a packaged build", () => {
    const dev = createAppConfig({ DOKAN_VAULT: "disabled" });
    expect(dev.vault).toBe("disabled");
    expect(dev.vaultOptOutIgnored).toBe(false);
  });

  it("forces the vault on when DOKAN_WEB_DIST marks a packaged build", () => {
    const packaged = createAppConfig({ DOKAN_VAULT: "disabled", DOKAN_WEB_DIST: "/opt/dokan/ui" });
    expect(packaged.vault).toBe("on");
    expect(packaged.vaultOptOutIgnored).toBe(true);
  });

  it("treats any other value as encryption on", () => {
    const config = createAppConfig({ DOKAN_VAULT: "off" });
    expect(config.vault).toBe("on");
    expect(config.vaultOptOutIgnored).toBe(false);
  });
});

/**
 * The app host (#343) — the NAME the app is reached at, which is what scopes
 * the vault cookie to this app alone. The api keeps binding 127.0.0.1; the
 * host is a different question and it has its own variable.
 */
describe("createAppConfig app host", () => {
  it("defaults to a name of its own, not 127.0.0.1 and not localhost", () => {
    const config = createAppConfig({});
    expect(config.appHost).toBe("dokan.localhost");
    // the bind address is untouched: nothing but this machine reaches the api
    expect(config.host).toBe("127.0.0.1");
  });

  it("treats a blank DOKAN_APP_HOST as unset", () => {
    expect(createAppConfig({ DOKAN_APP_HOST: "" }).appHost).toBe("dokan.localhost");
    expect(createAppConfig({ DOKAN_APP_HOST: "   " }).appHost).toBe("dokan.localhost");
  });

  it("reads an explicit host, and a deployment that must keep 127.0.0.1 still works", () => {
    expect(createAppConfig({ DOKAN_APP_HOST: "shop.internal" }).appHost).toBe("shop.internal");
    expect(createAppConfig({ DOKAN_APP_HOST: "127.0.0.1" }).appHost).toBe("127.0.0.1");
  });

  it("refuses a host that is not a bare hostname (fail loudly at boot)", () => {
    for (const raw of ["http://dokan.localhost:5173", "dokan.localhost:5173", "dokan..localhost"]) {
      expect(() => createAppConfig({ DOKAN_APP_HOST: raw })).toThrow(/bare hostname/);
    }
  });

  it("knows the browser-facing origin only when a web server is in front", () => {
    expect(createAppConfig({}).appOrigin).toBeUndefined();
    expect(createAppConfig({ DOKAN_WEB_PORT: "" }).appOrigin).toBeUndefined();
    expect(createAppConfig({ DOKAN_WEB_PORT: "5173" }).appOrigin).toBe("http://dokan.localhost:5173");
    expect(
      createAppConfig({ DOKAN_WEB_PORT: "5174", DOKAN_APP_HOST: "shop.internal" }).appOrigin,
    ).toBe("http://shop.internal:5174");
  });
});
