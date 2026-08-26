import { describe, expect, it } from "bun:test";

import { DEV_AUTH_SECRET, MIN_AUTH_SECRET_LEN, createAppConfig } from "./config";

/**
 * Ticket 15: the desktop bootstrap hands the api its app-data and resource
 * dirs through env. These fields must stay readable and degrade to today's
 * dev behavior when unset.
 */
describe("createAppConfig packaged-build overrides", () => {
  it("reads DOKAN_WEB_DIST as an absolute path", () => {
    const config = createAppConfig({ DOKAN_WEB_DIST: "C:\\Program Files\\Dokan\\ui" });
    expect(config.webDataDir).toBe("C:\\Program Files\\Dokan\\ui");
  });

  it("reads DOKAN_PORT_ROOT as an absolute path", () => {
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

  it("auth secret defaults to the dev sentinel only (PR #51 finding 5)", () => {
    // dev/test boot without DOKAN_AUTH_SECRET — the sentinel is never valid
    // in a packaged build (main.ts guard refuses those binaries at boot).
    const config = createAppConfig({});
    expect(config.authSecret).toBe(DEV_AUTH_SECRET);
    expect(config.authSecret.length).toBeLessThan(MIN_AUTH_SECRET_LEN);

    // an explicitly set secret wins (unit tests set test-auth-secret etc.)
    const explicit = createAppConfig({ DOKAN_AUTH_SECRET: "x".repeat(MIN_AUTH_SECRET_LEN) });
    expect(explicit.authSecret).toBe("x".repeat(MIN_AUTH_SECRET_LEN));
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