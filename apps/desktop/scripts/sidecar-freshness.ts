/**
 * Sidecar freshness: fingerprint the API sources and stamp the secret values
 * that were inlined, so `build.rs` can tell a current sidecar from a stale one
 * and never bundle yesterday's API with today's secrets (PR #117 finding 5).
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

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Fingerprint of everything that goes into the compiled sidecar: every file
 * under `<apiDir>/src` plus `<apiDir>/package.json`. Paths are relative,
 * POSIX-separated and sorted by UTF-8 bytes; each entry hashes
 * `path \0 content \0`.
 */
export function sidecarSourceFingerprint(apiDir: string): string {
  const files = [...walkFiles(path.join(apiDir, "src"))];
  const manifest = path.join(apiDir, "package.json");
  if (fs.existsSync(manifest)) files.push(manifest);

  const entries = files
    .map((file) => ({
      relative: path.relative(apiDir, file).split(path.sep).join("/"),
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
  buildSecret: string,
  authSecret: string,
): string {
  return (
    [
      SIDECAR_STAMP_VERSION,
      `customer ${customerSlug ?? "-"}`,
      `sources ${sourcesFingerprint}`,
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
  const content = renderSidecarStamp(sidecarSourceFingerprint(apiDir), customerSlug, buildSecret, authSecret);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarStampPath(sidecarPath), content, { mode: 0o600 });
}
