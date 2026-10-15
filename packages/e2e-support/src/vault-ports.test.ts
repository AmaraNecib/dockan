import { describe, expect, it } from "bun:test";

import {
  resolveVaultPorts,
  VAULT_API_PORT_DEFAULT,
  VAULT_WEB_PORT_DEFAULT,
} from "./vault-ports";

/** Put an env var back the way the test found it (unset stays unset). */
function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

describe("resolveVaultPorts", () => {
  it("pins the historical defaults (existing runs must not move)", () => {
    expect(VAULT_API_PORT_DEFAULT).toBe(4399);
    expect(VAULT_WEB_PORT_DEFAULT).toBe(5174);
    expect(resolveVaultPorts({})).toEqual({ api: 4399, web: 5174 });
  });

  it("treats blank and whitespace-only values as unset", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: "", DOKAN_VAULT_WEB_PORT: "   " })).toEqual({
      api: 4399,
      web: 5174,
    });
  });

  it("reads explicit overrides", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: "4510", DOKAN_VAULT_WEB_PORT: "5410" })).toEqual({
      api: 4510,
      web: 5410,
    });
  });

  it("resolves each port independently", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: "4510" })).toEqual({ api: 4510, web: 5174 });
    expect(resolveVaultPorts({ DOKAN_VAULT_WEB_PORT: "5410" })).toEqual({ api: 4399, web: 5410 });
  });

  it("accepts the inclusive 1..65535 range", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: "1", DOKAN_VAULT_WEB_PORT: "65535" })).toEqual({
      api: 1,
      web: 65535,
    });
  });

  it("accepts surrounding whitespace around a set value (Number trims)", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: " 4510 " }).api).toBe(4510);
  });

  // Pins the documented parsing: `Number()`, same as the api's DOKAN_PORT, so a
  // refactor to parseInt/regex cannot quietly change what a value means.
  it("parses with Number(), so hex and exponent strings resolve as numbers", () => {
    expect(resolveVaultPorts({ DOKAN_VAULT_PORT: "0x10" }).api).toBe(16);
    expect(resolveVaultPorts({ DOKAN_VAULT_WEB_PORT: "1e3" }).web).toBe(1000);
  });

  it("defaults to process.env when no environment is injected", () => {
    const savedApi = process.env.DOKAN_VAULT_PORT;
    const savedWeb = process.env.DOKAN_VAULT_WEB_PORT;
    process.env.DOKAN_VAULT_PORT = "4511";
    process.env.DOKAN_VAULT_WEB_PORT = "5411";
    try {
      expect(resolveVaultPorts()).toEqual({ api: 4511, web: 5411 });
    } finally {
      restoreEnv("DOKAN_VAULT_PORT", savedApi);
      restoreEnv("DOKAN_VAULT_WEB_PORT", savedWeb);
    }
  });

  // A typo must fail loudly: a fallback to 0/NaN would surface as a 20 s poll
  // timeout against the wrong port, which reads like a vault regression.
  const invalid = ["0", "-1", "65536", "4399.5", "abc", "NaN", "Infinity"];

  for (const raw of invalid) {
    // `toThrow(new Error(...))` matches the message exactly; `toThrow(string)`
    // only checks a substring, which would pass on a message that merely
    // contains the expected text (verified against bun:test).
    it(`rejects ${JSON.stringify(raw)} for DOKAN_VAULT_PORT by name`, () => {
      expect(() => resolveVaultPorts({ DOKAN_VAULT_PORT: raw })).toThrow(
        new Error(`DOKAN_VAULT_PORT must be a port number, got ${JSON.stringify(raw)}`),
      );
    });

    it(`rejects ${JSON.stringify(raw)} for DOKAN_VAULT_WEB_PORT by name`, () => {
      expect(() => resolveVaultPorts({ DOKAN_VAULT_WEB_PORT: raw })).toThrow(
        new Error(`DOKAN_VAULT_WEB_PORT must be a port number, got ${JSON.stringify(raw)}`),
      );
    });
  }
});
