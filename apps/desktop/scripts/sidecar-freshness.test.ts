import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fnv1a32Hex,
  fnv1a64Hex,
  sidecarBinaryFingerprint,
  sidecarSourceFingerprint,
  sidecarStampPath,
  stagedSidecarPath,
  writeSidecarStamp,
} from "./sidecar-freshness";

/**
 * The SAME golden value is asserted by the Rust test in
 * `apps/desktop/src-tauri/tests/sidecar_freshness.rs`. Both implementations
 * must fingerprint the same tree identically or build.rs stops trusting the
 * stamp written by the pipeline (PR #117 finding 5).
 */
const FIXTURE_ROOT = path.join(import.meta.dir, "__fixtures__", "api-fingerprint");
const FIXTURE_GOLDEN = "755844f99e63478f";

describe("fnv1a64Hex", () => {
  it("matches the published FNV-1a 64 vectors", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
  });
});

describe("fnv1a32Hex / sidecarBinaryFingerprint (PR #117 finding 2)", () => {
  it("matches the published FNV-1a 32 vectors", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
    expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
  });

  it("pins a file's bytes and changes when they change", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-bin-fp-"));
    const binary = path.join(dir, "sidecar.exe");
    writeFileSync(binary, "binary-bytes");
    // the same literal is asserted by the Rust integration test
    expect(sidecarBinaryFingerprint(binary)).toBe("f44e0ab6");
    writeFileSync(binary, "other-bytes");
    expect(sidecarBinaryFingerprint(binary)).toBe("8e3f4b73");
  });
});

describe("sidecarSourceFingerprint", () => {
  it("is deterministic and includes the fixture's API sources", () => {
    expect(sidecarSourceFingerprint(FIXTURE_ROOT)).toBe(FIXTURE_GOLDEN);
    expect(sidecarSourceFingerprint(FIXTURE_ROOT)).toBe(sidecarSourceFingerprint(FIXTURE_ROOT));
  });

  it("changes when a source file's content changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-fingerprint-"));
    mkdirSync(path.join(dir, "apps", "api", "src", "nested"), { recursive: true });
    writeFileSync(path.join(dir, "apps", "api", "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(dir, "apps", "api", "src", "main.ts"), "export const x = 1;\n");
    const before = sidecarSourceFingerprint(dir);

    writeFileSync(path.join(dir, "apps", "api", "src", "main.ts"), "export const x = 2;\n");
    expect(sidecarSourceFingerprint(dir)).not.toBe(before);

    writeFileSync(path.join(dir, "apps", "api", "src", "main.ts"), "export const x = 1;\n");
    expect(sidecarSourceFingerprint(dir)).toBe(before);
  });

  it("changes when a file is added, renamed or the package manifest changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-fingerprint-"));
    mkdirSync(path.join(dir, "apps", "api", "src"), { recursive: true });
    writeFileSync(path.join(dir, "apps", "api", "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(dir, "apps", "api", "src", "main.ts"), "export const x = 1;\n");
    const before = sidecarSourceFingerprint(dir);

    writeFileSync(path.join(dir, "apps", "api", "src", "extra.ts"), "export const y = 2;\n");
    expect(sidecarSourceFingerprint(dir)).not.toBe(before);
    writeFileSync(path.join(dir, "apps", "api", "src", "extra.ts"), "");

    writeFileSync(path.join(dir, "apps", "api", "package.json"), '{"name":"fixture","version":"2"}\n');
    expect(sidecarSourceFingerprint(dir)).not.toBe(before);
  });

  it("covers the workspace contracts and the lockfile (issue #134)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-fingerprint-"));
    mkdirSync(path.join(dir, "apps", "api", "src"), { recursive: true });
    mkdirSync(path.join(dir, "packages", "contracts", "src"), { recursive: true });
    writeFileSync(path.join(dir, "apps", "api", "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(dir, "apps", "api", "src", "main.ts"), "export const x = 1;\n");
    writeFileSync(path.join(dir, "packages", "contracts", "src", "index.ts"), "export const c = 1;\n");
    writeFileSync(path.join(dir, "bun.lock"), '{"lockfileVersion":1}\n');
    const before = sidecarSourceFingerprint(dir);

    writeFileSync(path.join(dir, "packages", "contracts", "src", "index.ts"), "export const c = 2;\n");
    expect(sidecarSourceFingerprint(dir)).not.toBe(before);
    writeFileSync(path.join(dir, "packages", "contracts", "src", "index.ts"), "export const c = 1;\n");
    expect(sidecarSourceFingerprint(dir)).toBe(before);

    writeFileSync(path.join(dir, "bun.lock"), '{"lockfileVersion":2}\n');
    expect(sidecarSourceFingerprint(dir)).not.toBe(before);
  });

  it("uses the sidecar name plus .stamp as the stamp path", () => {
    expect(sidecarStampPath("/tmp/binaries/dokan-api-x86_64-pc-windows-msvc.exe")).toBe(
      "/tmp/binaries/dokan-api-x86_64-pc-windows-msvc.exe.stamp",
    );
  });

  it("stamps beside the binary bun actually writes (platform suffix included)", () => {
    const outfile = "/tmp/binaries/dokan-api-x86_64-pc-windows-msvc";
    const landed = process.platform === "win32" ? `${outfile}.exe` : outfile;
    expect(stagedSidecarPath(outfile)).toBe(landed);
    expect(sidecarStampPath(stagedSidecarPath(outfile))).toBe(`${landed}.stamp`);
  });
});

describe("writeSidecarStamp", () => {
  it("records the customer, sources, binary and both secrets (never the secrets)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-stamp-"));
    const sidecar = path.join(dir, "sidecar.exe");
    writeFileSync(sidecar, "stamp-bytes");
    writeSidecarStamp(FIXTURE_ROOT, sidecar, "acme", "build-secret-0123456789", "a".repeat(40));

    const text = readFileSync(`${sidecar}.stamp`, "utf8");
    expect(text).toContain("dokan-sidecar-stamp v1");
    expect(text).toContain("customer acme");
    expect(text).toContain(`sources ${FIXTURE_GOLDEN}`);
    expect(text).toContain(`binary ${fnv1a32Hex("stamp-bytes")}`);
    expect(text).toContain(`build-secret ${fnv1a64Hex("build-secret-0123456789")}`);
    expect(text).toContain(`auth-secret ${fnv1a64Hex("a".repeat(40))}`);
    // the raw secret must never be written
    expect(text).not.toContain("build-secret-0123456789");
    expect(text).not.toContain("a".repeat(40));
  });

  it("marks a customer-less build with '-'", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-stamp-"));
    const sidecar = path.join(dir, "sidecar.exe");
    writeFileSync(sidecar, "stamp-bytes");
    writeSidecarStamp(FIXTURE_ROOT, sidecar, undefined, "build-secret-0123456789", "a".repeat(40));
    expect(readFileSync(`${sidecar}.stamp`, "utf8")).toContain("customer -\n");
  });
});
