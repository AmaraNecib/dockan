import { describe, expect, it } from "bun:test";

import { customerSlug, renamedInstaller } from "./release";
import { MIN_BUILD_SECRET_LEN, validateBuildSecret } from "./sidecar";

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
});