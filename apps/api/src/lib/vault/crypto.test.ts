import { describe, expect, it } from "bun:test";

import {
  DEFAULT_KDF_PARAMS,
  VaultAuthenticationError,
  deriveKey,
  generateMasterKey,
  generateSalt,
  normalizePassphrase,
  open,
  seal,
  sha256,
  tokensMatch,
  type KdfParams,
} from "./crypto";

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };

describe("vault crypto", () => {
  it("derives deterministically and separates by secret and salt", () => {
    const salt = Buffer.alloc(16, 3);
    const otherSalt = Buffer.alloc(16, 4);
    const a = deriveKey("correct horse battery", salt, FAST_KDF);
    const a2 = deriveKey("correct horse battery", salt, FAST_KDF);
    const b = deriveKey("correct horse battery", otherSalt, FAST_KDF);
    const c = deriveKey("another passphrase", salt, FAST_KDF);
    expect(a.equals(a2)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(c)).toBe(false);
  });

  it("normalizes NFC and surrounding whitespace before derivation", () => {
    const salt = Buffer.alloc(16, 5);
    expect(deriveKey("  café  ", salt, FAST_KDF).equals(deriveKey("cafe\u0301", salt, FAST_KDF))).toBe(true);
    expect(normalizePassphrase("  x  ")).toBe("x");
  });

  it("seals and opens with a fresh random nonce every time", () => {
    const key = generateMasterKey();
    const message = Buffer.from("the shop ledger");
    const aad = "dokan:vault:test:v1:vault-a";
    const first = seal(key, message, aad);
    const second = seal(key, message, aad);
    expect(first.equals(second)).toBe(false);
    // nonce ‖ ciphertext+tag, so the 12-byte nonce prefix differs
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
    expect(open(key, first, aad).equals(message)).toBe(true);
    expect(open(key, second, aad).equals(message)).toBe(true);
  });

  it("binds the AAD: the same bytes under another context fail", () => {
    const key = generateMasterKey();
    const sealed = seal(key, Buffer.from("snapshot"), "dokan:vault:db:v1:vault-a");
    expect(() => open(key, sealed, "dokan:vault:db:v1:vault-b")).toThrow(VaultAuthenticationError);
  });

  it("detects tampering and truncation", () => {
    const key = generateMasterKey();
    const sealed = seal(key, Buffer.from("snapshot"), "aad");
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0x01;
    expect(() => open(key, flipped, "aad")).toThrow(VaultAuthenticationError);
    expect(() => open(key, sealed.subarray(0, 20), "aad")).toThrow(VaultAuthenticationError);
    expect(() => open(generateMasterKey(), sealed, "aad")).toThrow(VaultAuthenticationError);
  });

  it("uses the documented default KDF parameters", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({
      algorithm: "argon2id",
      memoryKiB: 32768,
      iterations: 3,
      parallelism: 1,
      keyLength: 32,
    });
  });

  it("generates independent master keys and salts", () => {
    expect(generateMasterKey().equals(generateMasterKey())).toBe(false);
    expect(generateSalt().length).toBe(16);
    expect(generateSalt().equals(generateSalt())).toBe(false);
  });

  it("compares session tokens in constant time (length-safe)", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch(undefined, "abc")).toBe(false);
    expect(tokensMatch(null, "abc")).toBe(false);
  });

  it("hashes with sha256 (checksum input length)", () => {
    expect(sha256(Buffer.from("abc")).length).toBe(32);
  });
});
