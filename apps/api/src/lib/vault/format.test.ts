import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MAX_SNAPSHOT_STAMP_BYTES,
  VAULT_SNAPSHOT_LEGACY_VERSION,
  VAULT_SNAPSHOT_MAGIC,
  VAULT_SNAPSHOT_VERSION,
  base32Decode,
  base32Encode,
  fencedSnapshotAad,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  parseVaultHeader,
  readSnapshotFence,
  serializeVaultHeader,
  snapshotAad,
  wrapAad,
  type VaultHeader,
} from "./format";
import { DEFAULT_KDF_PARAMS, NONCE_BYTES, SALT_BYTES, WRAPPED_KEY_BYTES } from "./crypto";

const header = (): VaultHeader => ({
  format: 1,
  vaultId: "11111111-2222-3333-4444-555555555555",
  createdAt: "2026-10-01T00:00:00.000Z",
  kdf: DEFAULT_KDF_PARAMS,
  wraps: [
    {
      id: "wrap-aaaaaaaa",
      kind: "passphrase",
      salt: Buffer.alloc(SALT_BYTES, 1).toString("base64"),
      nonce: Buffer.alloc(NONCE_BYTES, 2).toString("base64"),
      ciphertext: Buffer.alloc(WRAPPED_KEY_BYTES, 3).toString("base64"),
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
});

describe("recovery codes", () => {
  it("generates 160 bits in 32 base32 chars plus a checksum, grouped for transcription", () => {
    const { code, bytes } = generateRecoveryCode();
    expect(bytes.length).toBe(20);
    // 8 groups of 4 plus the 2-char checksum group
    expect(code).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(code.replace(/-/g, "")).toHaveLength(34);
  });

  it("round-trips through parse, forgiving case and separators", () => {
    const { code, bytes } = generateRecoveryCode();
    const parsed = parseRecoveryCode(code.toLowerCase().replace(/-/g, " "));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a valid code");
    expect(parsed.bytes.equals(bytes)).toBe(true);
  });

  it("rejects a transcription typo in a KEY character (checksum catches the key, not just itself)", () => {
    const { code } = generateRecoveryCode();
    const raw = code.replace(/-/g, "");
    // flip one base32 character inside the 32-char key, not the checksum
    const index = 5;
    const original = raw[index]!;
    const typo = `${raw.slice(0, index)}${original === "A" ? "B" : "A"}${raw.slice(index + 1)}`;
    const parsed = parseRecoveryCode(typo);
    expect(parsed).toEqual({ ok: false, reason: "checksum" });
  });

  it("rejects a wrong length without a checksum error", () => {
    expect(parseRecoveryCode("ABCD-EFGH")).toEqual({ ok: false, reason: "format" });
  });

  it("base32 round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 7]);
    const decoded = base32Decode(base32Encode(bytes));
    expect(decoded).not.toBeNull();
    expect(decoded?.equals(bytes)).toBe(true);
  });

  it("formats the same bytes deterministically", () => {
    const bytes = Buffer.alloc(20, 9);
    expect(formatRecoveryCode(bytes)).toBe(formatRecoveryCode(bytes));
  });
});

describe("vault header", () => {
  it("round-trips through serialize/parse", () => {
    const original = header();
    const parsed = parseVaultHeader(serializeVaultHeader(original));
    expect(parsed).toEqual(original);
  });

  it("rejects malformed JSON and unknown formats", () => {
    expect(() => parseVaultHeader("{")).toThrow();
    expect(() => parseVaultHeader(JSON.stringify({ ...header(), format: 2 }))).toThrow();
  });

  it("requires exactly one passphrase wrap", () => {
    const two = header();
    two.wraps.push({ ...two.wraps[0]!, id: "wrap-bbbbbbbb" });
    expect(() => parseVaultHeader(JSON.stringify(two))).toThrow();
    const none = header();
    none.wraps = [];
    expect(() => parseVaultHeader(JSON.stringify(none))).toThrow();
  });

  it("rejects mis-sized cryptographic fields", () => {
    const bad = header();
    bad.wraps[0]!.ciphertext = Buffer.alloc(10).toString("base64");
    expect(() => parseVaultHeader(JSON.stringify(bad))).toThrow();
    const badNonce = header();
    badNonce.wraps[0]!.nonce = Buffer.alloc(11).toString("base64");
    expect(() => parseVaultHeader(JSON.stringify(badNonce))).toThrow();
  });

  it("caps recovery wraps at five", () => {
    const withSix = header();
    for (let index = 0; index < 6; index += 1) {
      withSix.wraps.push({ ...header().wraps[0]!, id: `recovery-${index}`, kind: "recovery" });
    }
    expect(() => parseVaultHeader(JSON.stringify(withSix))).toThrow();
  });

  it("refuses KDF parameters that only exist to stall unlock (crafted-header DoS)", () => {
    const hugeMemory = header();
    hugeMemory.kdf = { ...hugeMemory.kdf, memoryKiB: 1_048_576 };
    expect(() => parseVaultHeader(JSON.stringify(hugeMemory))).toThrow();
    const hugeTime = header();
    hugeTime.kdf = { ...hugeTime.kdf, iterations: 64 };
    expect(() => parseVaultHeader(JSON.stringify(hugeTime))).toThrow();
    const hugeParallelism = header();
    hugeParallelism.kdf = { ...hugeParallelism.kdf, parallelism: 8 };
    expect(() => parseVaultHeader(JSON.stringify(hugeParallelism))).toThrow();
    // the sane maximum stays accepted
    const max = header();
    max.kdf = { ...max.kdf, memoryKiB: 262_144, iterations: 10, parallelism: 4 };
    expect(() => parseVaultHeader(JSON.stringify(max))).not.toThrow();
  });
});

describe("snapshot envelope fence (#280)", () => {
  const legacy = () => Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_LEGACY_VERSION]), Buffer.alloc(48, 9)]);
  const fenced = (stamp: string) => {
    const stampBytes = Buffer.from(stamp, "utf8");
    return Buffer.concat([
      VAULT_SNAPSHOT_MAGIC,
      Buffer.from([VAULT_SNAPSHOT_VERSION]),
      Buffer.from([stampBytes.length]),
      stampBytes,
      Buffer.alloc(48, 9),
    ]);
  };

  it("reads the legacy envelope as unfenced", () => {
    expect(readSnapshotFence(legacy())).toEqual({ version: VAULT_SNAPSHOT_LEGACY_VERSION, stamp: undefined, bodyOffset: VAULT_SNAPSHOT_MAGIC.length + 1 });
  });

  it("reads the holder stamp and body offset of a fenced envelope", () => {
    const fence = readSnapshotFence(fenced("holder-token"));
    expect(fence?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(fence?.stamp).toBe("holder-token");
    expect(fence?.bodyOffset).toBe(VAULT_SNAPSHOT_MAGIC.length + 1 + 1 + "holder-token".length);
  });

  it("refuses to decide a truncated, foreign-header, unknown-version or bad-length envelope", () => {
    expect(readSnapshotFence(Buffer.alloc(4))).toBeUndefined();
    expect(readSnapshotFence(Buffer.concat([Buffer.from("NOTVAULT"), Buffer.alloc(16)]))).toBeUndefined();
    expect(readSnapshotFence(Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([9]), Buffer.alloc(48)]))).toBeUndefined();
    // a zero length, and a length past the bound
    expect(readSnapshotFence(Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION, 0]), Buffer.alloc(48)]))).toBeUndefined();
    expect(
      readSnapshotFence(Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION, MAX_SNAPSHOT_STAMP_BYTES + 1]), Buffer.alloc(80)])),
    ).toBeUndefined();
    // the stamp claims more bytes than the envelope holds
    expect(readSnapshotFence(Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION, 8]), Buffer.from("abcd")]))).toBeUndefined();
  });
});

/**
 * The three AEAD contexts are the one thing in this module that cannot ever be
 * re-derived: editing one makes existing bytes undecryptable, and no migration
 * can fix it because the key that would re-seal them is inside the thing that
 * no longer opens. So each is pinned to its exact string, by hand, with no
 * interpolation and no constant.
 */
describe("AEAD contexts are frozen strings", () => {
  const vaultId = "11111111-2222-3333-4444-555555555555";

  it("pins the legacy snapshot AAD", () => {
    expect(snapshotAad(vaultId)).toBe("dokan:vault:db:v1:11111111-2222-3333-4444-555555555555");
  });

  it("pins the fenced snapshot AAD", () => {
    expect(fencedSnapshotAad(vaultId, "holder-token")).toBe(
      "dokan:vault:db:v2:11111111-2222-3333-4444-555555555555:holder-token",
    );
  });

  it("pins the wrapped-key AAD", () => {
    expect(wrapAad(vaultId, "passphrase")).toBe("dokan:vault:wrap:v1:11111111-2222-3333-4444-555555555555:passphrase");
  });

  it("builds the fenced AAD from a literal, not from the envelope version constant", () => {
    // A source scan on purpose. An assertion on the returned value cannot see
    // the difference while the two numbers happen to agree, and the whole point
    // of the literal is that the envelope version is now free to diverge from
    // it. This is the check that fails on the regression: rebuilding the AAD
    // from `VAULT_SNAPSHOT_VERSION` makes a format bump move the context every
    // format-2 snapshot on disk was sealed with.
    const formatTs = readFileSync(fileURLToPath(new URL("./format.ts", import.meta.url)), "utf8");
    const builder = /export function fencedSnapshotAad[\s\S]*?\n}/.exec(formatTs)?.[0];
    expect(builder).toBeDefined();
    expect(builder).toContain("dokan:vault:db:v2:");
    expect(builder).not.toContain("VAULT_SNAPSHOT_VERSION");
  });
});
