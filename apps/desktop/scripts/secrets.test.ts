import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MIN_AUTH_SECRET_LEN,
  MIN_BUILD_SECRET_LEN,
} from "./sidecar";
import { ensureReleaseSecrets, generateSecret, parseEnvFile, renderEnvFile } from "./secrets";

/** A fresh throwaway env file per test; nothing touches the real apps/desktop/.env. */
function scratchEnvFile(contents?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dokan-secrets-"));
  const file = path.join(dir, ".env");
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

describe("generateSecret", () => {
  it("returns the requested length and only URL-safe characters", () => {
    const secret = generateSecret(32);
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never returns the same value twice", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSecret(24)));
    expect(seen.size).toBe(200);
  });

  it("is long enough for both minimums", () => {
    expect(generateSecret(MIN_BUILD_SECRET_LEN).length).toBeGreaterThanOrEqual(MIN_BUILD_SECRET_LEN);
    expect(generateSecret(MIN_AUTH_SECRET_LEN).length).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_LEN);
  });
});

describe("parseEnvFile / renderEnvFile", () => {
  it("round-trips values, ignoring comments and blank lines", () => {
    const rendered = renderEnvFile({ DOKAN_BUILD_SECRET: "abc", DOKAN_AUTH_SECRET: "def" }, "header");
    const parsed = parseEnvFile(rendered);
    expect(parsed).toEqual({ DOKAN_BUILD_SECRET: "abc", DOKAN_AUTH_SECRET: "def" });
  });

  it("keeps unrelated keys when rewriting", () => {
    const rendered = renderEnvFile({ SOMETHING_ELSE: "keep", DOKAN_AUTH_SECRET: "def" }, "header");
    expect(parseEnvFile(rendered).SOMETHING_ELSE).toBe("keep");
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# a comment\n\nA=1\n")).toEqual({ A: "1" });
  });
});

describe("ensureReleaseSecrets", () => {
  it("generates both secrets into the env file when neither is set", () => {
    const file = scratchEnvFile();
    const result = ensureReleaseSecrets({ env: {}, envFilePath: file });

    expect(result.generated.sort()).toEqual(["DOKAN_AUTH_SECRET", "DOKAN_BUILD_SECRET"]);
    expect(result.secrets.DOKAN_BUILD_SECRET.length).toBeGreaterThanOrEqual(MIN_BUILD_SECRET_LEN);
    expect(result.secrets.DOKAN_AUTH_SECRET.length).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_LEN);

    // and the file is what a later build reads
    const written = parseEnvFile(readFileSync(file, "utf8"));
    expect(written.DOKAN_BUILD_SECRET).toBe(result.secrets.DOKAN_BUILD_SECRET);
    expect(written.DOKAN_AUTH_SECRET).toBe(result.secrets.DOKAN_AUTH_SECRET);
  });

  it("is stable: a second run reuses the file instead of rotating", () => {
    const file = scratchEnvFile();
    const first = ensureReleaseSecrets({ env: {}, envFilePath: file });
    const second = ensureReleaseSecrets({ env: {}, envFilePath: file });

    // a rotating auth secret would sign every shop out on every rebuild
    expect(second.secrets).toEqual(first.secrets);
    expect(second.generated).toEqual([]);
    expect(second.sources.DOKAN_AUTH_SECRET).toBe("file");
  });

  it("lets an explicit environment variable win over the file", () => {
    const file = scratchEnvFile(renderEnvFile({ DOKAN_BUILD_SECRET: "from-file-0123456789" }, "header"));
    const result = ensureReleaseSecrets({
      env: { DOKAN_BUILD_SECRET: "from-env-0123456789" },
      envFilePath: file,
    });

    expect(result.secrets.DOKAN_BUILD_SECRET).toBe("from-env-0123456789");
    expect(result.sources.DOKAN_BUILD_SECRET).toBe("env");
    // the file keeps its own value: an override is for one build, not a rewrite
    expect(parseEnvFile(readFileSync(file, "utf8")).DOKAN_BUILD_SECRET).toBe("from-file-0123456789");
  });

  it("fills only the missing half and leaves the present one alone", () => {
    const file = scratchEnvFile();
    const result = ensureReleaseSecrets({ env: { DOKAN_BUILD_SECRET: "pinned-build-secret-1" }, envFilePath: file });

    expect(result.secrets.DOKAN_BUILD_SECRET).toBe("pinned-build-secret-1");
    expect(result.generated).toEqual(["DOKAN_AUTH_SECRET"]);
    expect(parseEnvFile(readFileSync(file, "utf8")).DOKAN_BUILD_SECRET).toBeUndefined();
  });

  it("still refuses an explicit secret below the minimum", () => {
    const file = scratchEnvFile();
    expect(() => ensureReleaseSecrets({ env: { DOKAN_BUILD_SECRET: "too-short" }, envFilePath: file })).toThrow(
      /at least 16/,
    );
    expect(() => ensureReleaseSecrets({ env: { DOKAN_AUTH_SECRET: "x".repeat(31) }, envFilePath: file })).toThrow(
      /at least 32/,
    );
  });

  it("refuses a weak value sitting in the file", () => {
    const file = scratchEnvFile(renderEnvFile({ DOKAN_AUTH_SECRET: "short" }, "header"));
    expect(() => ensureReleaseSecrets({ env: {}, envFilePath: file })).toThrow(/at least 32/);
  });

  it("creates the env file's directory when it does not exist yet", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-secrets-nested-"));
    const file = path.join(dir, "nested", ".env");
    const result = ensureReleaseSecrets({ env: {}, envFilePath: file });
    expect(parseEnvFile(readFileSync(file, "utf8")).DOKAN_AUTH_SECRET).toBe(result.secrets.DOKAN_AUTH_SECRET);
  });
});

describe("ensureReleaseSecrets source reporting (bun pre-loads .env)", () => {
  it("reports 'file' when the env value is the file's own value", () => {
    // `bun run` loads apps/desktop/.env into process.env, so the value arrives
    // through the env AND the file. It came from the file; say so.
    const file = scratchEnvFile(renderEnvFile({ DOKAN_AUTH_SECRET: "x".repeat(40) }, "header"));
    const stored = parseEnvFile(readFileSync(file, "utf8"));
    const result = ensureReleaseSecrets({ env: { ...stored }, envFilePath: file });
    expect(result.sources.DOKAN_AUTH_SECRET).toBe("file");
  });

  it("reports 'env' only for a genuine override", () => {
    const file = scratchEnvFile(renderEnvFile({ DOKAN_AUTH_SECRET: "x".repeat(40) }, "header"));
    const result = ensureReleaseSecrets({ env: { DOKAN_AUTH_SECRET: "y".repeat(40) }, envFilePath: file });
    expect(result.sources.DOKAN_AUTH_SECRET).toBe("env");
    expect(result.secrets.DOKAN_AUTH_SECRET).toBe("y".repeat(40));
  });
});
