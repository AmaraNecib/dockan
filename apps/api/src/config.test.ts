import { describe, expect, it } from "bun:test";

import { createAppConfig } from "./config";

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
});