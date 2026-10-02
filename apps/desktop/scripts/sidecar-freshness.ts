/**
 * Sidecar freshness: fingerprint the API sources, the compiled binary and the
 * secret values that were inlined, so `build.rs` can tell a current sidecar
 * from a stale or torn one and never bundle yesterday's API — or another
 * customer's binary — with today's secrets (PR #117 findings 1, 2, 5).
 *
 * The fingerprint format is duplicated (in the small) by the
 * `src-tauri/sidecar-freshness` Rust crate that `build.rs` uses; both editors
 * are pinned to the same golden fixture value by their tests.
 */

import fs from "node:fs";
import path from "node:path";

export const SIDECAR_STAMP_VERSION = "dokan-sidecar-stamp v1";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

function fnv1a64Bytes(start: bigint, bytes: Uint8Array): bigint {
  let hash = start;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash;
}

/** FNV-1a 64 of `input`, as 16 lower-case hex digits. */
export function fnv1a64Hex(input: string): string {
  return fnv1a64Bytes(FNV_OFFSET, Buffer.from(input, "utf8")).toString(16).padStart(16, "0");
}

function fnv1a32Bytes(bytes: Uint8Array): number {
  let hash = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i += 1) {
    // SAFETY: `i` is bounded by `bytes.length`, so the element exists.
    hash ^= bytes[i] as number;
    // Math.imul keeps this a 32-bit FNV-1a and stays fast over a ~100 MB exe.
    hash = Math.imul(hash, FNV32_PRIME) >>> 0;
  }
  return hash;
}

/** FNV-1a 32 of `input`, as 8 lower-case hex digits. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32Bytes(Buffer.from(input, "utf8")).toString(16).padStart(8, "0");
}

/**
 * FNV-1a 32 of a file's bytes. The sidecar stamp pins the exact binary, so a
 * compile that overwrote only the binary (without its stamp) is detected.
 */
export function sidecarBinaryFingerprint(binaryPath: string): string {
  return fnv1a32Bytes(fs.readFileSync(binaryPath)).toString(16).padStart(8, "0");
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Fingerprint of everything that goes into the compiled sidecar: the API
 * sources and manifest, the workspace contracts the API imports at runtime,
 * and the root lockfile (issue #134 / PR #117 re-review finding 8). Paths are
 * relative to `repoRoot`, POSIX-separated and sorted by UTF-8 bytes; each
 * entry hashes `path \0 content \0`.
 */
export function sidecarSourceFingerprint(repoRoot: string): string {
  const roots = [
    path.join(repoRoot, "apps", "api", "src"),
    path.join(repoRoot, "apps", "api", "package.json"),
    path.join(repoRoot, "packages", "contracts", "src"),
    path.join(repoRoot, "bun.lock"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (fs.statSync(root).isDirectory()) files.push(...walkFiles(root));
    else files.push(root);
  }

  const entries = files
    .map((file) => ({
      relative: path.relative(repoRoot, file).split(path.sep).join("/"),
      content: fs.readFileSync(file),
    }))
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.relative, "utf8"), Buffer.from(b.relative, "utf8")),
    );

  let hash = FNV_OFFSET;
  for (const { relative, content } of entries) {
    hash = fnv1a64Bytes(hash, Buffer.from(relative, "utf8"));
    hash = fnv1a64Bytes(hash, Buffer.from([0]));
    hash = fnv1a64Bytes(hash, content);
    hash = fnv1a64Bytes(hash, Buffer.from([0]));
  }
  return hash.toString(16).padStart(16, "0");
}

/** The freshness stamp that sits next to a staged sidecar binary. */
export function sidecarStampPath(sidecarPath: string): string {
  return `${sidecarPath}.stamp`;
}

/**
 * The sidecar as it lands on disk: `bun build --compile` appends the platform
 * executable suffix to the `--outfile` path when it is missing. The stamp must
 * sit beside the binary that really exists, or `build.rs` will never find it
 * and will rebuild without the inlined secrets.
 */
export function stagedSidecarPath(outfile: string): string {
  return process.platform === "win32" ? `${outfile}.exe` : outfile;
}

/** Render the stamp `build.rs` reads; secret values never appear, only hashes. */
export function renderSidecarStamp(
  sourcesFingerprint: string,
  customerSlug: string | undefined,
  binaryFingerprint: string,
  buildSecret: string,
  authSecret: string,
): string {
  return (
    [
      SIDECAR_STAMP_VERSION,
      `customer ${customerSlug ?? "-"}`,
      `sources ${sourcesFingerprint}`,
      `binary ${binaryFingerprint}`,
      `build-secret ${fnv1a64Hex(buildSecret)}`,
      `auth-secret ${fnv1a64Hex(authSecret)}`,
    ].join("\n") + "\n"
  );
}

/**
 * Record what the freshly compiled sidecar was built from. `build.rs` refuses
 * to reuse the sidecar unless the stamp matches its own fingerprint check, and
 * a slugged build refuses any sidecar not stamped for that customer.
 */
export function writeSidecarStamp(
  apiDir: string,
  sidecarPath: string,
  customerSlug: string | undefined,
  buildSecret: string,
  authSecret: string,
): void {
  const content = renderSidecarStamp(
    sidecarSourceFingerprint(apiDir),
    customerSlug,
    sidecarBinaryFingerprint(sidecarPath),
    buildSecret,
    authSecret,
  );
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarStampPath(sidecarPath), content, { mode: 0o600 });
}
