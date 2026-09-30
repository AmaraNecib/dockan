import { describe, expect, it } from "bun:test";

import { customerSlug, findInstallerName, renamedInstaller } from "./release";
import { MIN_AUTH_SECRET_LEN, MIN_BUILD_SECRET_LEN, validateAuthSecret, validateBuildSecret } from "./sidecar";

/**
 * PR #51 finding 2: the per-customer build secret is a build-time input —
 * the release pipeline must never ship a default or weak secret.
 */
describe("validateBuildSecret", () => {
  it("rejects a missing secret (never ship a default)", () => {
    expect(validateBuildSecret({})).toEqual({
      ok: false,
      reason: "DOKAN_BUILD_SECRET is not set — refusing to ship a default secret",
    });
    expect(validateBuildSecret({ DOKAN_BUILD_SECRET: "" })).toEqual({
      ok: false,
      reason: "DOKAN_BUILD_SECRET is not set — refusing to ship a default secret",
    });
  });

  it("rejects a weak secret below the minimum length", () => {
    expect(validateBuildSecret({ DOKAN_BUILD_SECRET: "x".repeat(MIN_BUILD_SECRET_LEN - 1) })).toEqual({
      ok: false,
      reason: `DOKAN_BUILD_SECRET is only ${MIN_BUILD_SECRET_LEN - 1} chars — must be at least ${MIN_BUILD_SECRET_LEN}`,
    });
  });

  it("accepts a secret at and above the minimum length", () => {
    const atMin = validateBuildSecret({ DOKAN_BUILD_SECRET: "s".repeat(MIN_BUILD_SECRET_LEN) });
    expect(atMin).toEqual({ ok: true, secret: "s".repeat(MIN_BUILD_SECRET_LEN) });
    const long = validateBuildSecret({ DOKAN_BUILD_SECRET: "shop-secret-0123456789-abcdef" });
    expect(long).toEqual({ ok: true, secret: "shop-secret-0123456789-abcdef" });
  });
});

describe("validateAuthSecret (PR #51 finding 5 — session-forgery)", () => {
  it("rejects a missing secret (never ship a shared signing default)", () => {
    expect(validateAuthSecret({})).toEqual({
      ok: false,
      reason: "DOKAN_AUTH_SECRET is not set — refusing to ship a default session-signing secret",
    });
    expect(validateAuthSecret({ DOKAN_AUTH_SECRET: "" })).toEqual({
      ok: false,
      reason: "DOKAN_AUTH_SECRET is not set — refusing to ship a default session-signing secret",
    });
  });

  it("rejects a weak secret below the minimum length", () => {
    expect(validateAuthSecret({ DOKAN_AUTH_SECRET: "x".repeat(MIN_AUTH_SECRET_LEN - 1) })).toEqual({
      ok: false,
      reason: `DOKAN_AUTH_SECRET is only ${MIN_AUTH_SECRET_LEN - 1} chars — must be at least ${MIN_AUTH_SECRET_LEN}`,
    });
  });

  it("accepts a secret at and above the minimum length", () => {
    const atMin = validateAuthSecret({ DOKAN_AUTH_SECRET: "s".repeat(MIN_AUTH_SECRET_LEN) });
    expect(atMin).toEqual({ ok: true, secret: "s".repeat(MIN_AUTH_SECRET_LEN) });
    const long = validateAuthSecret({ DOKAN_AUTH_SECRET: "shop-signing-0123456789abcdefghijklmnopqrstuvwxyz" });
    expect(long.ok).toBe(true);
  });

  it("release mains exit 1 on a weak explicit secret instead of shipping it", async () => {
    // A MISSING secret is no longer fatal: it is generated into the gitignored
    // env file, which secrets.test.ts covers. Only a weak one is refused — and
    // that refusal happens before the sidecar compile, so this stays cheap.
    const weak = Bun.spawn(["bun", "scripts/release.ts"], {
      env: { ...process.env, DOKAN_BUILD_SECRET: "valid-build-secret-123", DOKAN_AUTH_SECRET: "short" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const weakCode = await weak.exited;
    const weakErr = await new Response(weak.stderr).text();
    expect(weakCode).toBe(1);
    expect(weakErr).toContain("must be at least 32");
  });
});

describe("customerSlug / renamedInstaller (installer naming)", () => {
  it("keeps the default name when no slug is set", () => {
    expect(customerSlug(undefined)).toBeUndefined();
    expect(customerSlug("")).toBeUndefined();
    expect(customerSlug("   ")).toBeUndefined();
  });

  it("sanitizes the slug charset", () => {
    expect(customerSlug("ACME Shop!")).toBeUndefined();
    expect(customerSlug("acme-shop")).toBe("acme-shop");
    expect(customerSlug("shop2")).toBe("shop2");
  });

  it("inserts the slug into the tauri artifact name", () => {
    expect(renamedInstaller("Dokan_0.1.0_x64-setup.exe", "acme-shop")).toBe("Dokan_0.1.0_acme-shop_x64-setup.exe");
    expect(renamedInstaller("Dokan_0.2.5_arm64-setup.exe", "b")).toBe("Dokan_0.2.5_b_arm64-setup.exe");
  });

  it("only renames the pristine artifact — never an already-slung file", () => {
    expect(findInstallerName(["Dokan_0.1.0_x64-setup.exe"])).toBe("Dokan_0.1.0_x64-setup.exe");
    expect(findInstallerName(["Dokan_0.1.0_acme-shop_x64-setup.exe"])).toBeUndefined();
    expect(findInstallerName(["Dokan_0.1.0_acme-shop_acme-shop_x64-setup.exe"])).toBeUndefined();
    expect(findInstallerName(["Dokan_0.2.5_arm64-setup.exe", "README.txt"])).toBe("Dokan_0.2.5_arm64-setup.exe");
  });
});