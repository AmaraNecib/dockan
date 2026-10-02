import { randomBytes } from "node:crypto";

import { z } from "zod";

import { DEFAULT_KDF_PARAMS, NONCE_BYTES, SALT_BYTES, WRAPPED_KEY_BYTES, sha256 } from "./crypto";

/**
 * The vault's on-disk format: the recovery-code container and the `vault.json`
 * header. Nothing here is secret; the header holds only wrapped keys. Parsing
 * is strict (zod) and format-versioned so a malformed or newer file is refused
 * instead of being silently reinterpreted.
 */

export const VAULT_FORMAT_VERSION = 1;

/** The header file is decoded into this shape; see docs/one-build-and-recovery.md §4.6. */
export type VaultWrap = {
  id: string;
  kind: "passphrase" | "recovery";
  label?: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
};

export type VaultHeader = {
  format: number;
  vaultId: string;
  createdAt: string;
  kdf: typeof DEFAULT_KDF_PARAMS;
  wraps: VaultWrap[];
};

/** A vault file that cannot be trusted (bad JSON, bad lengths, unknown format). */
export class VaultFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFormatError";
  }
}

const wrapSchema = z.object({
  id: z.string().min(8).max(64),
  kind: z.enum(["passphrase", "recovery"]),
  label: z.string().max(64).optional(),
  salt: z.string().min(1).max(128),
  nonce: z.string().min(1).max(128),
  ciphertext: z.string().min(1).max(512),
  createdAt: z.string().min(1).max(64),
});

const headerSchema = z.object({
  format: z.literal(VAULT_FORMAT_VERSION),
  vaultId: z.string().min(8).max(64),
  createdAt: z.string().min(1).max(64),
  kdf: z.object({
    algorithm: z.literal("argon2id"),
    // sane maxima (finding: crafted-header lockout DoS): a 1 GiB / t=64 header
    // would make every unlock attempt an unbounded CPU stall. Real vaults use
    // the 32 MiB / t=3 defaults; these bounds leave headroom while refusing a
    // header that can only exist to deny service.
    memoryKiB: z.number().int().min(8).max(262_144),
    iterations: z.number().int().min(1).max(10),
    parallelism: z.number().int().min(1).max(4),
    keyLength: z.literal(32),
  }),
  wraps: z.array(wrapSchema).min(1).max(6),
});

function decodeBase64(value: string, field: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new VaultFormatError(`vault header ${field} is not base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expectedLength) {
    throw new VaultFormatError(`vault header ${field} has length ${bytes.length}, expected ${expectedLength}`);
  }
  return bytes;
}

/**
 * Decode `vault.json`. Throws VaultFormatError for anything the format does
 * not define: a newer format version, a missing passphrase wrap, more than the
 * allowed recovery wraps, or mis-sized cryptographic fields. A vault whose
 * header is unreadable must never be overwritten by a setup flow.
 */
export function parseVaultHeader(text: string): VaultHeader {
  let decoded: string | number | boolean | null | Array<string | number | boolean | null> | { [key: string]: string | number | boolean | null };
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new VaultFormatError("vault header is not valid JSON");
  }
  const parsed = headerSchema.safeParse(decoded);
  if (!parsed.success) throw new VaultFormatError("vault header does not match the vault format");
  const header = parsed.data;
  const passphraseWraps = header.wraps.filter((wrap) => wrap.kind === "passphrase");
  const recoveryWraps = header.wraps.filter((wrap) => wrap.kind === "recovery");
  if (passphraseWraps.length !== 1) throw new VaultFormatError("vault header must carry exactly one passphrase wrap");
  if (recoveryWraps.length > 5) throw new VaultFormatError("vault header carries more than five recovery wraps");
  for (const wrap of header.wraps) {
    decodeBase64(wrap.salt, "salt", SALT_BYTES);
    decodeBase64(wrap.nonce, "nonce", NONCE_BYTES);
    decodeBase64(wrap.ciphertext, "ciphertext", WRAPPED_KEY_BYTES);
  }
  return header;
}

/** Serialise the header with a trailing newline so the file is diff-friendly and atomic-writable. */
export function serializeVaultHeader(header: VaultHeader): string {
  return `${JSON.stringify(header, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/*  Recovery codes                                                     */
/* ------------------------------------------------------------------ */

/**
 * RFC 4648 base32 without padding. The alphabet omits 0/1/8/9 look-alikes
 * (standard base32) so the transcribed code cannot be misread as digits.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 20 random bytes = 160 bits of entropy (design floor: ≥128 bits). */
export const RECOVERY_KEY_BYTES = 20;
/** 160 bits → 32 base32 characters. */
const RECOVERY_KEY_CHARS = 32;
/** 10 bits of SHA-256 → two base32 characters appended for typo detection. */
const RECOVERY_CHECKSUM_CHARS = 2;

export type RecoveryCodeParse =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "format" | "checksum" };

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decode base32 text; returns null for characters outside the alphabet. */
export function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function recoveryChecksum(keyBytes: Uint8Array): string {
  const digest = sha256(keyBytes);
  const bits = ((digest[0] ?? 0) << 2) | ((digest[1] ?? 0) >> 6);
  return `${BASE32_ALPHABET[(bits >> 5) & 31]}${BASE32_ALPHABET[bits & 31]}`;
}

/** Generate a recovery code: 160 random bits plus its checksum. */
export function generateRecoveryCode() {
  const bytes = randomBytes(RECOVERY_KEY_BYTES);
  return { code: formatRecoveryCode(bytes), bytes };
}

/** Render a recovery code in groups of four characters (and the 2-char checksum). */
export function formatRecoveryCode(bytes: Uint8Array): string {
  const raw = `${base32Encode(bytes)}${recoveryChecksum(bytes)}`;
  const groups = raw.match(/.{1,4}/g) ?? [];
  return groups.join("-");
}

/* ------------------------------------------------------------------ */
/*  Encrypted snapshot envelope                                        */
/* ------------------------------------------------------------------ */

/** First bytes of every `dokan.db.enc` file. */
export const VAULT_SNAPSHOT_MAGIC = Buffer.from("DKNVAULT", "ascii");
/** One format byte after the magic; bump when the envelope changes. */
export const VAULT_SNAPSHOT_VERSION = 1;

/** AEAD context for the database snapshot of one vault. */
export function snapshotAad(vaultId: string): string {
  return `dokan:vault:db:v${VAULT_FORMAT_VERSION}:${vaultId}`;
}

/** AEAD context for one wrapped master key. */
export function wrapAad(vaultId: string, kind: VaultWrap["kind"]): string {
  return `dokan:vault:wrap:v${VAULT_FORMAT_VERSION}:${vaultId}:${kind}`;
}

/**
 * Parse a typed or pasted recovery code. Separators and case are forgiving;
 * length, alphabet and checksum are not. A bad checksum is rejected here so a
 * typo never costs an Argon2id derivation (and never reaches unwrapping).
 */
export function parseRecoveryCode(input: string): RecoveryCodeParse {
  const normalized = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (normalized.length !== RECOVERY_KEY_CHARS + RECOVERY_CHECKSUM_CHARS) {
    return { ok: false, reason: "format" };
  }
  const keyText = normalized.slice(0, RECOVERY_KEY_CHARS);
  const checksumText = normalized.slice(RECOVERY_KEY_CHARS);
  const bytes = base32Decode(keyText);
  if (bytes === null || bytes.length !== RECOVERY_KEY_BYTES) return { ok: false, reason: "format" };
  if (recoveryChecksum(bytes) !== checksumText) return { ok: false, reason: "checksum" };
  return { ok: true, bytes };
}
