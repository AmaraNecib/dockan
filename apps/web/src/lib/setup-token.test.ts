import { describe, expect, it } from "bun:test";

import { parseSetupToken } from "./setup-token";

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
});
