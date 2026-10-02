import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MIN_AUTH_SECRET_LEN, MIN_BUILD_SECRET_LEN } from "./sidecar";
import {
  ensureReleaseSecrets,
  envTempPath,
  generateSecret,
  mergeEnvFile,
  parseEnvFile,
  releaseEnvHeader,
  renderEnvFile,
} from "./secrets";

/** A fresh throwaway env file per test; nothing touches the real apps/desktop/.env. */
function scratchEnvFile(contents?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dokan-secrets-"));
  const file = path.join(dir, ".env");
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "dokan-secrets-"));
}

const quotedAuth = (value: string): string => `DOKAN_AUTH_SECRET="${value}"`;

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

describe("parseEnvFile matches Bun's dotenv rules (PR #117 findings 1/5)", () => {
  it("strips single quotes, inline comments and `export`, like Bun's loader", () => {
    // verified against `bun -e` on Bun 1.4: the base-file preload guard
    // compares Bun's loaded value with this parser, so they must agree
    expect(parseEnvFile(`A='single'\nB=inline # comment\nC=no-space#comment\nD="a#b"\nexport E=exported\nF=  spaced  \nG=\n`)).toEqual({
      A: "single",
      B: "inline",
      C: "no-space",
      D: "a#b",
      E: "exported",
      F: "spaced",
      G: "",
    });
  });
});

describe("mergeEnvFile (PR #117 finding 3 — never re-serialise existing values)", () => {
  it("preserves quoted values with trailing spaces byte-for-byte", () => {
    const original = `# golden copy\nDOKAN_AUTH_SECRET="keep me "\nOTHER=untouched\n`;
    const merged = mergeEnvFile(original, { DOKAN_BUILD_SECRET: "fresh-value" });
    expect(merged).toContain(`DOKAN_AUTH_SECRET="keep me "`);
    expect(merged).toContain("# golden copy");
    expect(merged).toContain("OTHER=untouched");
    expect(merged).toContain("DOKAN_BUILD_SECRET=fresh-value");
  });

  it("replaces an existing empty line for the generated key instead of duplicating it", () => {
    const merged = mergeEnvFile("DOKAN_BUILD_SECRET=\n", { DOKAN_BUILD_SECRET: "fresh" });
    expect(merged).toBe("DOKAN_BUILD_SECRET=fresh\n");
  });

  it("appends a missing key and keeps the file newline-terminated", () => {
    expect(mergeEnvFile("A=1", { B: "2" })).toBe("A=1\nB=2\n");
    expect(mergeEnvFile("A=1\n", { B: "2" })).toBe("A=1\nB=2\n");
  });

  it("keeps an `export ` prefix and a CRLF ending on a replaced line", () => {
    expect(mergeEnvFile("export DOKAN_BUILD_SECRET=old\r\nOTHER=1\r\n", { DOKAN_BUILD_SECRET: "new" })).toBe(
      "export DOKAN_BUILD_SECRET=new\r\nOTHER=1\r\n",
    );
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
    expect(result.envFilePath).toBe(file);
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

describe("ensureReleaseSecrets quoting (PR #117 finding 3)", () => {
  it("preserves a quoted stored secret while generating the missing half", () => {
    const file = scratchEnvFile();
    // a trailing space only survives because the line is quoted; re-serialising
    // it unquoted would change the effective signing key on the next load
    const auth = "a".repeat(40) + " ";
    writeFileSync(file, `# keep me\n${quotedAuth(auth)}\nOTHER=value\n`);

    const result = ensureReleaseSecrets({ env: {}, envFilePath: file });

    expect(result.secrets.DOKAN_AUTH_SECRET).toBe(auth);
    expect(result.generated).toEqual(["DOKAN_BUILD_SECRET"]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(quotedAuth(auth));
    expect(text).toContain("# keep me");
    expect(text).toContain("OTHER=value");
    // a later build reads the exact same auth secret
    expect(ensureReleaseSecrets({ env: {}, envFilePath: file }).secrets.DOKAN_AUTH_SECRET).toBe(auth);
  });

  it("does not touch the file when both values are already stored", () => {
    const file = scratchEnvFile(`# custom header\n${quotedAuth("b".repeat(40) + " ")}\nDOKAN_BUILD_SECRET=build-secret-0123456789\n`);
    const before = readFileSync(file, "utf8");
    const result = ensureReleaseSecrets({ env: {}, envFilePath: file });
    expect(result.generated).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("ensureReleaseSecrets file permissions (PR #117 finding 2)", () => {
  it.skipIf(process.platform === "win32")("restricts a pre-existing loose file to owner-only", () => {
    const file = scratchEnvFile(renderEnvFile({ DOKAN_AUTH_SECRET: "c".repeat(40) }, releaseEnvHeader()));
    chmodSync(file, 0o644);
    ensureReleaseSecrets({ env: {}, envFilePath: file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a read-only pre-existing file instead of failing on it", () => {
    const file = scratchEnvFile(renderEnvFile({ DOKAN_AUTH_SECRET: "d".repeat(40) }, releaseEnvHeader()));
    chmodSync(file, 0o444);
    try {
      const result = ensureReleaseSecrets({ env: {}, envFilePath: file });
      expect(result.generated).toEqual(["DOKAN_BUILD_SECRET"]);
      expect(parseEnvFile(readFileSync(file, "utf8")).DOKAN_AUTH_SECRET).toBe("d".repeat(40));
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("ensureReleaseSecrets per customer (PR #117 finding 1)", () => {
  it("gives each customer slug its own secret set", () => {
    const dir = scratchDir();
    const acme = ensureReleaseSecrets({ env: {}, envDir: dir, customerSlug: "acme" });
    const beta = ensureReleaseSecrets({ env: {}, envDir: dir, customerSlug: "beta" });

    expect(acme.envFilePath).toBe(path.join(dir, ".env.acme"));
    expect(beta.envFilePath).toBe(path.join(dir, ".env.beta"));
    expect(acme.secrets.DOKAN_AUTH_SECRET).not.toBe(beta.secrets.DOKAN_AUTH_SECRET);
    expect(acme.secrets.DOKAN_BUILD_SECRET).not.toBe(beta.secrets.DOKAN_BUILD_SECRET);
    // the customer-less default file was never created or touched
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    // and each slug is stable on a rebuild
    expect(ensureReleaseSecrets({ env: {}, envDir: dir, customerSlug: "acme" }).secrets).toEqual(acme.secrets);
  });

  it("does not leak the base .env (preloaded by `bun run`) into a slugged build", () => {
    const dir = scratchDir();
    const baseText = renderEnvFile(
      { DOKAN_BUILD_SECRET: "base-build-secret-0001", DOKAN_AUTH_SECRET: "b".repeat(40) },
      releaseEnvHeader(),
    );
    writeFileSync(path.join(dir, ".env"), baseText);
    // `bun run` puts the base file's values into process.env before the script
    const preloaded = parseEnvFile(baseText);

    const result = ensureReleaseSecrets({ env: { ...preloaded }, envDir: dir, customerSlug: "acme" });

    expect(result.secrets.DOKAN_BUILD_SECRET).not.toBe("base-build-secret-0001");
    expect(result.secrets.DOKAN_AUTH_SECRET).not.toBe("b".repeat(40));
    expect(result.generated.sort()).toEqual(["DOKAN_AUTH_SECRET", "DOKAN_BUILD_SECRET"]);
    // the base file keeps its own values
    expect(parseEnvFile(readFileSync(path.join(dir, ".env"), "utf8")).DOKAN_BUILD_SECRET).toBe("base-build-secret-0001");
  });

  it("still honours a genuine override for a slugged build without persisting it", () => {
    const dir = scratchDir();
    writeFileSync(
      path.join(dir, ".env"),
      renderEnvFile({ DOKAN_BUILD_SECRET: "base-build-secret-0001" }, releaseEnvHeader()),
    );

    const result = ensureReleaseSecrets({
      env: { DOKAN_BUILD_SECRET: "override-build-secret-02" },
      envDir: dir,
      customerSlug: "acme",
    });

    expect(result.secrets.DOKAN_BUILD_SECRET).toBe("override-build-secret-02");
    expect(result.sources.DOKAN_BUILD_SECRET).toBe("env");
    expect(result.generated).toEqual(["DOKAN_AUTH_SECRET"]);
    const slugged = parseEnvFile(readFileSync(path.join(dir, ".env.acme"), "utf8"));
    expect(slugged.DOKAN_BUILD_SECRET).toBeUndefined();
    expect(slugged.DOKAN_AUTH_SECRET).toBe(result.secrets.DOKAN_AUTH_SECRET);
  });

  it("does not leak a single-quoted or exported base .env value either", () => {
    const dir = scratchDir();
    // both forms load identically through Bun, but a naive parser would keep
    // the quotes / `export` and treat the preload as an explicit override
    writeFileSync(path.join(dir, ".env"), `export DOKAN_BUILD_SECRET='base-build-secret-01'\nDOKAN_AUTH_SECRET='${"b".repeat(40)}'\n`);
    const preloaded = { DOKAN_BUILD_SECRET: "base-build-secret-01", DOKAN_AUTH_SECRET: "b".repeat(40) };

    const result = ensureReleaseSecrets({ env: preloaded, envDir: dir, customerSlug: "acme" });

    expect(result.secrets.DOKAN_BUILD_SECRET).not.toBe("base-build-secret-01");
    expect(result.secrets.DOKAN_AUTH_SECRET).not.toBe("b".repeat(40));
    expect(result.generated.sort()).toEqual(["DOKAN_AUTH_SECRET", "DOKAN_BUILD_SECRET"]);
  });

  it("honours an explicit override equal to the customer-less value when no preload is possible", () => {
    // the package scripts run with `bun --no-env-file`, so an env value is
    // always deliberate — even when it happens to equal the base `.env` value
    // (PR #117 finding 3)
    const dir = scratchDir();
    const baseBuild = "base-build-secret-0001";
    writeFileSync(path.join(dir, ".env"), renderEnvFile({ DOKAN_BUILD_SECRET: baseBuild }, releaseEnvHeader()));

    const result = ensureReleaseSecrets({
      env: { DOKAN_BUILD_SECRET: baseBuild },
      envDir: dir,
      customerSlug: "acme",
      envIsExplicit: true,
    });

    expect(result.secrets.DOKAN_BUILD_SECRET).toBe(baseBuild);
    expect(result.sources.DOKAN_BUILD_SECRET).toBe("env");
    // and a one-off override is never written into the customer file
    expect(parseEnvFile(readFileSync(path.join(dir, ".env.acme"), "utf8")).DOKAN_BUILD_SECRET).toBeUndefined();
  });

  it("detects BUN_OPTIONS=--no-env-file and honours an override equal to the base value", async () => {
    const dir = scratchDir();
    const baseBuild = "base-build-secret-0001";
    writeFileSync(path.join(dir, ".env"), renderEnvFile({ DOKAN_BUILD_SECRET: baseBuild }, releaseEnvHeader()));
    const secretsModule = pathToFileURL(path.join(import.meta.dir, "secrets.ts")).href;
    const child = `
      const mod = await import(${JSON.stringify(secretsModule)});
      const result = mod.ensureReleaseSecrets({ customerSlug: "acme" });
      console.log(JSON.stringify({ secrets: result.secrets, sources: result.sources }));
    `;
    const env = { ...process.env, BUN_OPTIONS: "--no-env-file", DOKAN_BUILD_SECRET: baseBuild };
    delete env.DOKAN_AUTH_SECRET;
    delete env.DOKAN_CUSTOMER_SLUG;
    const proc = Bun.spawn(["bun", "-e", child], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`child failed: ${code}\n${err}`);

    const result = JSON.parse(out.trim());
    expect(result.secrets.DOKAN_BUILD_SECRET).toBe(baseBuild);
    expect(result.sources.DOKAN_BUILD_SECRET).toBe("env");
  });

  it("rejects a slug that could escape the secrets directory", () => {
    const dir = scratchDir();
    expect(() => ensureReleaseSecrets({ env: {}, envDir: dir, customerSlug: "../evil" })).toThrow(/slug/);
    expect(() => ensureReleaseSecrets({ env: {}, envDir: dir, customerSlug: "ACME" })).toThrow(/slug/);
    expect(existsSync(path.join(dir, "..", "evil"))).toBe(false);
  });
});

describe("ensureReleaseSecrets concurrency (PR #117 finding 4)", () => {
  it("converges two concurrent first-time generations on one secret set", async () => {
    const dir = scratchDir();
    const file = path.join(dir, ".env");
    const secretsModule = pathToFileURL(path.join(import.meta.dir, "secrets.ts")).href;
    // both children take a slow path BETWEEN resolving "missing" and writing,
    // which is exactly the window the unlocked implementation loses the race in
    const child = `
      const mod = await import(${JSON.stringify(secretsModule)});
      const result = mod.ensureReleaseSecrets({
        env: {},
        envFilePath: process.env.RACE_ENV_FILE,
        generate: (len) => {
          Bun.sleepSync(Number(process.env.RACE_SLEEP_MS));
          return mod.generateSecret(len);
        },
      });
      console.log(JSON.stringify(result.secrets));
    `;
    const spawnChild = () =>
      Bun.spawn(["bun", "-e", child], {
        cwd: import.meta.dir,
        env: { ...process.env, RACE_ENV_FILE: file, RACE_SLEEP_MS: "400" },
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = spawnChild();
    const second = spawnChild();
    const [firstOut, firstErr, secondOut, secondErr, firstCode, secondCode] = await Promise.all([
      new Response(first.stdout).text(),
      new Response(first.stderr).text(),
      new Response(second.stdout).text(),
      new Response(second.stderr).text(),
      first.exited,
      second.exited,
    ]);
    if (firstCode !== 0 || secondCode !== 0) {
      throw new Error(`race children failed: ${firstCode}/${secondCode}\n${firstErr}\n${secondErr}`);
    }

    const a = JSON.parse(firstOut.trim());
    const b = JSON.parse(secondOut.trim());
    expect(b).toEqual(a);
    expect(parseEnvFile(readFileSync(file, "utf8"))).toEqual(a);
  }, 20_000);

  it("steals a stale lock and finishes generation", () => {
    const dir = scratchDir();
    const file = path.join(dir, ".env");
    const lock = `${file}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const result = ensureReleaseSecrets({ env: {}, envFilePath: file, lockStaleMs: 1_000 });

    expect(result.generated.sort()).toEqual(["DOKAN_AUTH_SECRET", "DOKAN_BUILD_SECRET"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("fails loudly with the lock path when a live lock never clears", () => {
    const dir = scratchDir();
    const file = path.join(dir, ".env");
    const lock = `${file}.lock`;
    writeFileSync(lock, "");

    expect(() =>
      ensureReleaseSecrets({ env: {}, envFilePath: file, lockWaitMs: 60, lockRetryMs: 10, lockStaleMs: 60_000 }),
    ).toThrow(/timed out waiting for/);
    // the live holder's lock is left alone
    expect(existsSync(lock)).toBe(true);
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

describe("envTempPath (PR #117 finding 4)", () => {
  it("keeps the .env. prefix so the .env.* ignore rule covers a crash leftover", () => {
    expect(path.basename(envTempPath("/x/.env"))).toMatch(/^\.env\.[0-9]+\.[0-9a-f]+\.tmp$/);
    expect(path.basename(envTempPath("/x/.env.acme"))).toMatch(/^\.env\.acme\.[0-9]+\.[0-9a-f]+\.tmp$/);
    // the old `..env...tmp` shape did not match `.env.*`
    expect(path.basename(envTempPath("/x/.env")).startsWith("..")).toBe(false);
  });
});

describe("secrets CLI", () => {
  const cli = path.join(import.meta.dir, "secrets-cli.ts");

  // `bun run`/`bun test` pre-load apps/desktop/.env into the test process, and
  // a child would inherit those as explicit overrides — which is exactly the
  // precedence the CLI is supposed to honour. Scrub them so the test measures
  // file generation, not the developer's shell.
  function scrubbedEnv() {
    const env = { ...process.env };
    delete env.DOKAN_BUILD_SECRET;
    delete env.DOKAN_AUTH_SECRET;
    delete env.DOKAN_CUSTOMER_SLUG;
    return env;
  }

  async function runCli(cwd: string, args: string[]) {
    const proc = Bun.spawn(["bun", cli, ...args], { cwd, env: scrubbedEnv(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  it("writes the per-customer file selected by --customer", async () => {
    const dir = scratchDir();
    const { stdout, code } = await runCli(dir, ["--customer", "acme"]);

    expect(code).toBe(0);
    expect(stdout).toContain(path.join(dir, ".env.acme"));
    const written = parseEnvFile(readFileSync(path.join(dir, ".env.acme"), "utf8"));
    expect(written.DOKAN_BUILD_SECRET.length).toBeGreaterThanOrEqual(MIN_BUILD_SECRET_LEN);
    expect(written.DOKAN_AUTH_SECRET.length).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_LEN);
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
  });

  it("refuses an invalid --customer instead of silently using the default file", async () => {
    const dir = scratchDir();
    const { stderr, code } = await runCli(dir, ["--customer", "Not A Slug"]);

    expect(code).toBe(1);
    expect(stderr).toContain("slug");
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    expect(existsSync(path.join(dir, ".env.Not A Slug"))).toBe(false);
  });
});
