import { describe, expect, it } from "bun:test";

import { parseSetupToken, preserveSetupTokenFromHash, readSetupToken } from "./setup-token";

/**
 * The packaged shell navigates the webview to `/#setup_token=<token>`; the
 * fragment is never sent to the server. Only the app's own window can read it,
 * which is what gates `firstTimeSetup` (ADR-0008 ownership race).
 */
describe("parseSetupToken", () => {
  it("reads the token out of the shell's fragment", () => {
    expect(parseSetupToken("#setup_token=abc123")).toBe("abc123");
    expect(parseSetupToken("#other=1&setup_token=abc123")).toBe("abc123");
    expect(parseSetupToken("#setup_token=abc%2D123")).toBe("abc-123");
  });

  it("returns undefined without a token or on malformed input", () => {
    expect(parseSetupToken("")).toBeUndefined();
    expect(parseSetupToken("#other=1")).toBeUndefined();
    expect(parseSetupToken("#setup_token=")).toBeUndefined();
    expect(parseSetupToken("#setup_token=%E0%A4%A")).toBeUndefined();
  });

  it("keeps the reset token available when sessionStorage denies reads and writes", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    if (!descriptor?.configurable) throw new Error("sessionStorage getter is not replaceable in this test environment");
    const original = window.sessionStorage;
    const restoreStorage: Storage = {
      get length() { return original.length; },
      clear: () => original.clear(),
      key: (index) => original.key(index),
      removeItem: (key) => original.removeItem(key),
      getItem: () => { throw new Error("storage denied"); },
      setItem: () => { throw new Error("storage denied"); },
    };
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => restoreStorage });
    const previousHash = window.location.hash;
    try {
      window.location.hash = "#setup_token=denied-storage-token&session_reset_epoch=restore-epoch";
      expect(() => preserveSetupTokenFromHash()).not.toThrow();
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      expect(readSetupToken()).toBe("denied-storage-token");
    } finally {
      Object.defineProperty(window, "sessionStorage", descriptor);
      window.location.hash = previousHash;
      original.clear();
    }
  });
});
