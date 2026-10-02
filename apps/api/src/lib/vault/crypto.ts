import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { argon2id } from "@noble/hashes/argon2";

/**
 * Vault cryptography. Every primitive here is delegated to a well-known
 * implementation — no hand-rolled cipher, KDF or MAC:
 *
 * - Argon2id: `@noble/hashes` (audited pure-TypeScript implementation).
 * - AES-256-GCM: `node:crypto` (Bun's native OpenSSL-backed cipher).
 * - Randomness: `node:crypto.randomBytes` (the OS CSPRNG).
 *
 * The library and parameters are recorded in `vault.json` so a future reader
 * can reproduce a wrap without guessing. Changing any parameter means a new
 * vault format version, never a silent reinterpretation of an old one.
 */

export const MASTER_KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
/** wrapped master key = 32 plaintext bytes + 16 GCM tag bytes */
export const WRAPPED_KEY_BYTES = MASTER_KEY_BYTES + GCM_TAG_BYTES;

/** The KDF parameters stored in the vault header. */
export type KdfParams = {
  algorithm: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  keyLength: number;
};

/**
 * Default KDF parameters. OWASP's Argon2id floor is m=19456 KiB, t=2, p=1;
 * these are deliberately above it. Measured on a development machine at
 * ~0.75 s for the pure-TS implementation, so a slow shop laptop stays within
 * a tolerable unlock delay.
 */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: "argon2id",
  memoryKiB: 32768,
  iterations: 3,
  parallelism: 1,
  keyLength: MASTER_KEY_BYTES,
};

/** A secret failed authentication (wrong passphrase/recovery key, bad tag). */
export class VaultAuthenticationError extends Error {
  constructor() {
    super("vault authentication failed");
    this.name = "VaultAuthenticationError";
  }
}

const utf8 = new TextEncoder();

/**
 * Unicode-normalise and trim the typed passphrase so the same visible text
 * derives the same key on every keyboard and platform. Trimming is deliberate:
 * a passphrase pasted with a trailing newline from a text file must still open
 * the vault. The transformation is applied identically at setup and unlock.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFC").trim();
}

/** Argon2id(secret, salt) → keyLength bytes. */
export function deriveKey(secret: string | Uint8Array, salt: Uint8Array, params: KdfParams = DEFAULT_KDF_PARAMS): Buffer {
  const input = secret instanceof Uint8Array ? secret : utf8.encode(normalizePassphrase(secret));
  return Buffer.from(
    argon2id(input, salt, {
      m: params.memoryKiB,
      t: params.iterations,
      p: params.parallelism,
      dkLen: params.keyLength,
    }),
  );
}

/** A fresh 32-byte master key. */
export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

/** A fresh random salt. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * AES-256-GCM seal: `nonce ‖ ciphertext ‖ tag`. A fresh random 96-bit nonce
 * per call; the key is per-vault, so the reuse bound (2^32 messages) is far
 * above any realistic snapshot or wrap count.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * AES-256-GCM open. Any tampering, wrong key or wrong context throws
 * VaultAuthenticationError — callers translate it to the Arabic refusal; the
 * function never returns partial plaintext.
 */
export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  if (sealed.length < NONCE_BYTES + GCM_TAG_BYTES) throw new VaultAuthenticationError();
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // SAFETY: node:crypto throws Error subclasses for a failed tag; the only
    // contract this module exposes is the auth failure, so both are mapped.
    if (error instanceof Error) throw new VaultAuthenticationError();
    throw error;
  }
}

/** SHA-256 digest (used for the recovery-code checksum). */
export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** Constant-time equality for session tokens. */
export function tokensMatch(provided: string | null | undefined, expected: string): boolean {
  if (provided === null || provided === undefined) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
