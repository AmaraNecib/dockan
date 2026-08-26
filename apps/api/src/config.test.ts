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