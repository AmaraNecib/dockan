/**
 * Release secrets with a stable, editable default (issue: release ergonomics).
 *
 * The per-customer secrets used to be required on the build command line. They
 * now live in gitignored files next to the desktop package: `apps/desktop/.env`
 * for the customer-less build, and `apps/desktop/.env.<slug>` for a build with
 * `DOKAN_CUSTOMER_SLUG` set — one secret set per customer, so two shops built
 * from the same checkout can never share a signing key (PR #117 finding 1).
 *
 * Precedence, and why:
 *   1. an explicit environment variable — for the one build that needs a
 *      specific shop's secret, without rewriting the file;
 *   2. the value already in this customer's env file — so a rebuild is stable;
 *   3. a freshly generated value, written to that file.
 *
 * Stability is not cosmetic. A rotating `DOKAN_AUTH_SECRET` would invalidate
 * every session on the next rebuild, and a rotating `DOKAN_BUILD_SECRET` would
 * break the owner's password-reset path for a shop that already has data. So
 * the generated values are persisted and reused, never regenerated per build.
 *
 * Both values keep the original guarantees: unique per customer, never
 * committed, never in the runtime environment, never logged, never written to
 * app-data. The file is the place to read or change them.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MIN_AUTH_SECRET_LEN,
  MIN_BUILD_SECRET_LEN,
  validateAuthSecret,
  validateBuildSecret,
  type SecretValidation,
} from "./secret-rules";

/** File the pipeline reads its secrets from. cwd is apps/desktop under `bun run`. */
export const RELEASE_ENV_FILENAME = ".env";
export const RELEASE_ENV_DIR = path.resolve(".");
export const RELEASE_ENV_PATH = path.join(RELEASE_ENV_DIR, RELEASE_ENV_FILENAME);

/** Suffix of the cross-process lock that guards first-time generation. */
export const RELEASE_ENV_LOCK_SUFFIX = ".lock";

/** How long to wait for another process that is generating secrets right now. */
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 25;
/** A generation is milliseconds; a lock this old means its owner crashed. */
const LOCK_STALE_MS = 60_000;

const CUSTOMER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `KEY=value` with an optional `export ` prefix, matching what Bun's dotenv
 * loader accepts. Quoted values are handled by {@link parseEnvValue}.
 */
const ENV_LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Bun's dotenv value rules, as observed on Bun 1.4:
 *   - a value starting with `"` or `'` closes at its matching quote
 *     (backslash escapes the next character inside `"` only, and the
 *     backslash is kept verbatim); the value is everything between, possibly
 *     spanning lines, and anything after the closing quote — an inline
 *     `# comment` or trailing junk — is ignored;
 *   - a quote with NO closer anywhere in the rest of the file keeps the rest
 *     of its line, INCLUDING the opening quote, with an inline comment
 *     stripped;
 *   - otherwise the first `#` starts a comment and the rest is trimmed.
 * Keeping this in lockstep matters: the base/ambient preload check compares
 * the value Bun loaded against a re-parse of the same line, and a divergence
 * would let a customer-less secret pass as an explicit override
 * (PR #117 findings 1, re-review findings 1 for commented quotes and
 * unmatched quotes).
 */
function findClosingQuote(value: string, quote: string, start: number): number {
  for (let i = start; i < value.length; i += 1) {
    if (quote === '"' && value[i] === "\\") {
      i += 1; // escaped character: Bun keeps the backslash but skips the quote
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

interface ParsedEnvValue {
  value: string;
  lastLine: number;
}

/**
 * Parse one line's value the way Bun does. Returns the value and the index of
 * the last line it consumed (a quote can span lines when a closer exists
 * later in the file).
 */
function parseEnvValueFrom(rest: string, lines: string[], lineIndex: number): ParsedEnvValue {
  const value = rest.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    for (let i = lineIndex; i < lines.length; i += 1) {
      const haystack = i === lineIndex ? value : lines[i] ?? "";
      const close = findClosingQuote(haystack, quote, i === lineIndex ? 1 : 0);
      if (close === -1) continue;
      const parts =
        i === lineIndex
          ? [value.slice(1, close)]
          : [value.slice(1), ...lines.slice(lineIndex + 1, i), haystack.slice(0, close)];
      return { value: parts.join("\n"), lastLine: i };
    }
    // No closer anywhere: Bun keeps the opening quote and the rest of the
    // line (comment stripped), and parses the following lines normally.
    const comment = value.indexOf("#");
    return { value: (comment === -1 ? value : value.slice(0, comment)).trim(), lastLine: lineIndex };
  }
  const comment = value.indexOf("#");
  return { value: (comment === -1 ? value : value.slice(0, comment)).trim(), lastLine: lineIndex };
}

/** The `KEY` and `export ` prefix of a `KEY=value` line, or undefined. */
function envLineParts(line: string): { key: string; exportPrefix: string } | undefined {
  const match = ENV_LINE_PATTERN.exec(line.trim());
  const key = match?.[1];
  if (key === undefined) return undefined;
  return { key, exportPrefix: /^\s*export\s+/.test(line) ? "export " : "" };
}

/** Validate a customer slug before it becomes part of a file name. */
export function assertCustomerSlug(slug: string): string {
  if (!CUSTOMER_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `customer slug ${JSON.stringify(slug)} is invalid — use lower-case letters, digits and dashes ([a-z0-9][a-z0-9-]*)`,
    );
  }
  return slug;
}

/** The env file a build reads: `<dir>/.env` or `<dir>/.env.<slug>`. */
export function releaseEnvPathFor(slug: string | undefined, dir: string = RELEASE_ENV_DIR): string {
  return slug === undefined
    ? path.join(dir, RELEASE_ENV_FILENAME)
    : path.join(dir, `${RELEASE_ENV_FILENAME}.${slug}`);
}

/** Printed at the top of a generated env file. */
export function releaseEnvHeader(slug?: string): string {
  const scope = slug === undefined ? "the customer-less build" : `customer "${slug}"`;
  return [
    `# Per-customer release secrets for ${scope} — GITIGNORED, never commit this file.`,
    "#",
    "# Generated once and then reused on every build. Keep a copy per customer:",
    "# rebuilding for a shop needs the SAME two values, or that shop can no",
    "# longer reset its owner password and its sessions stop verifying.",
    "#",
    "# To change one, edit it here. To override for a single build, pass it on the",
    "# command line (DOKAN_AUTH_SECRET=... bun run desktop:portable).",
  ].join("\n");
}

export const RELEASE_ENV_HEADER = releaseEnvHeader();

/** A cryptographically random, URL-safe secret of exactly `len` characters. */
export function generateSecret(len: number): string {
  // base64url encodes 3 bytes as 4 chars, so this always has enough to slice
  return randomBytes(Math.ceil((len * 3) / 4) + 3)
    .toString("base64url")
    .slice(0, len);
}

/** Key/value pairs read from an env file. */
export interface EnvFileValues {
  [key: string]: string;
}

/** Read `KEY=value` lines, ignoring blanks and comments, like Bun's loader. */
export function parseEnvFile(text: string): EnvFileValues {
  const values: EnvFileValues = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = ENV_LINE_PATTERN.exec(trimmed);
    const key = match?.[1];
    if (match === null || key === undefined) continue;
    const parsed = parseEnvValueFrom(match[2] ?? "", lines, i);
    values[key] = parsed.value;
    i = parsed.lastLine;
  }
  return values;
}

/** Render `values` as an env file, with an optional comment header. */
export function renderEnvFile(values: EnvFileValues, header?: string): string {
  const lines = Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key]}`);
  const prefix = header === undefined || header === "" ? "" : `${header.trimEnd()}\n`;
  return `${prefix}${lines.join("\n")}\n`;
}

/**
 * Write `values` into existing env-file text without touching any other line.
 *
 * Re-serialising the whole file (the old `renderEnvFile({ ...stored, ...new })`)
 * changed the effective value of every quote-sensitive line: a quoted secret
 * with a trailing space was written unquoted and the next parse trimmed it,
 * silently rotating the signing key (PR #117 finding 3). Only lines for the
 * keys being written are replaced; everything else survives byte-for-byte.
 */
export function mergeEnvFile(text: string, values: EnvFileValues): string {
  const lines = text.split("\n");
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  const body = trailingNewline ? lines.slice(0, -1) : lines;
  const written = new Set<string>();
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (line === undefined) continue;
    const parts = envLineParts(line);
    if (parts === undefined || !Object.hasOwn(values, parts.key)) continue;
    // preserve the line's own `export ` prefix and CRLF ending
    const eol = line.endsWith("\r") ? "\r" : "";
    body[i] = `${parts.exportPrefix}${parts.key}=${values[parts.key]}${eol}`;
    written.add(parts.key);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) body.push(`${key}=${value}`);
  }
  return `${body.join("\n")}\n`;
}

export type SecretSource = "env" | "file" | "generated";

export type ReleaseSecretKey = "DOKAN_BUILD_SECRET" | "DOKAN_AUTH_SECRET";

export interface ResolvedReleaseSecrets {
  secrets: { DOKAN_BUILD_SECRET: string; DOKAN_AUTH_SECRET: string };
  sources: { DOKAN_BUILD_SECRET: SecretSource; DOKAN_AUTH_SECRET: SecretSource };
  /** Keys that were missing everywhere and had to be created. */
  generated: ReleaseSecretKey[];
  /** The env file these values were read from or written to. */
  envFilePath: string;
  /** The customer slug that selected the file, if any. */
  customerSlug: string | undefined;
}

/** One secret's rules, so both keys go through the same path. */
interface SecretSpec {
  key: ReleaseSecretKey;
  min: number;
  validate: (env: NodeJS.ProcessEnv) => SecretValidation;
}

const BUILD_SECRET_SPEC: SecretSpec = {
  key: "DOKAN_BUILD_SECRET",
  min: MIN_BUILD_SECRET_LEN,
  validate: validateBuildSecret,
};
const AUTH_SECRET_SPEC: SecretSpec = {
  key: "DOKAN_AUTH_SECRET",
  min: MIN_AUTH_SECRET_LEN,
  validate: validateAuthSecret,
};

interface ResolvedOne {
  key: ReleaseSecretKey;
  value: string;
  source: SecretSource;
  created: boolean;
}

interface ResolveContext {
  env: NodeJS.ProcessEnv;
  stored: EnvFileValues;
  /** The customer-less `.env`; only meaningful while resolving a slugged build. */
  baseStored: EnvFileValues;
  /**
   * Values from the `.env` the OUTER `bun run` may have pre-loaded (the cwd
   * above the desktop package). A match here is inherited, never an override.
   */
  ambientStored: EnvFileValues;
  envFilePath: string;
  slug: string | undefined;
  /** True when every DOKAN_* value in `env` came from the caller, not `.env`. */
  envIsExplicit: boolean;
  generate: (len: number) => string;
}

/**
 * One secret, by precedence: an explicit environment variable, then the stored
 * value, then a freshly generated one. A value that is present but weak is
 * fatal — a default may be generated, a weak one must never ship.
 */
function resolveOne(spec: SecretSpec, ctx: ResolveContext): ResolvedOne {
  const explicit = ctx.env[spec.key];
  if (explicit !== undefined) {
    const fromTargetFile = ctx.stored[spec.key] === explicit;
    // A value inherited from the outer-cwd `.env` — or from the customer-less
    // `.env` when auto-loading was not proven off — is never an override. That
    // includes an EMPTY value: an inherited `DOKAN_X=` must not block a valid
    // `.env.<slug>` (PR #117 re-review finding 2).
    const fromAmbientFile = ctx.ambientStored[spec.key] === explicit;
    const fromBaseFile = ctx.baseStored[spec.key] === explicit;
    const inherited = fromAmbientFile || (!ctx.envIsExplicit && fromBaseFile);
    if (!inherited) {
      // A genuine explicit empty value is a broken configuration, not a
      // missing one: generating a replacement would silently rotate the
      // signing key / password-reset secret on the next rebuild.
      if (explicit === "") {
        const check = spec.validate({ [spec.key]: explicit });
        throw new Error(`${spec.key}: ${check.ok ? "is empty — refusing to ship a default secret" : check.reason}`);
      }
      const check = spec.validate({ [spec.key]: explicit });
      if (!check.ok) throw new Error(`${spec.key}: ${check.reason}`);
      // An env value that MATCHES the file came from the file; call it "file"
      // so the owner is pointed at the place to edit.
      return { key: spec.key, value: explicit, source: fromTargetFile ? "file" : "env", created: false };
    }
  }

  const fromFile = ctx.stored[spec.key];
  if (fromFile !== undefined) {
    // An empty line (`KEY=`) in the file is a broken configuration too: it
    // must not be silently replaced by a fresh secret.
    const check = spec.validate({ [spec.key]: fromFile });
    if (!check.ok) throw new Error(`${spec.key}: ${check.reason} (in ${ctx.envFilePath})`);
    return { key: spec.key, value: fromFile, source: "file", created: false };
  }

  return { key: spec.key, value: ctx.generate(spec.min), source: "generated", created: true };
}

export interface EnsureSecretOptions {
  env?: NodeJS.ProcessEnv;
  /** Directory holding the release env files. Defaults to the cwd. */
  envDir?: string;
  /** Explicit env-file path; bypasses the slug/envDir selection (tests). */
  envFilePath?: string;
  /** Select this customer's `.env.<slug>`; defaults to `env.DOKAN_CUSTOMER_SLUG`. */
  customerSlug?: string;
  /**
   * True when every DOKAN_* value in `env` was supplied by the caller. The
   * entry points run under `BUN_OPTIONS=--no-env-file` and detect it
   * automatically; tests simulate a pre-loaded environment by leaving this
   * false.
   */
  envIsExplicit?: boolean;
  /**
   * File whose values are treated as inherited from the outer process (tests).
   * Defaults to the `.env` / `.env.local` two directories above the desktop
   * package — the cwd the outer `bun run` pre-loads from.
   */
  ambientEnvFilePath?: string;
  generate?: (len: number) => string;
  /** Test seams for the cross-process generation lock. */
  lockWaitMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

/**
 * Best-effort `chmod 0600` for a release-secrets file. Called on every read
 * path, not only when a value is generated (PR #117 re-review finding 3).
 * Missing files and Windows ACLs are ignored.
 */
function restrictSecretFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // no such file, or a platform whose ACLs do not map to POSIX modes
  }
}

function readEnvFile(envFilePath: string): EnvFileValues {
  try {
    return parseEnvFile(fs.readFileSync(envFilePath, "utf8"));
  } catch (error) {
    // SAFETY: node/Bun fs errors carry a string `code`; a missing file is the
    // only failure this helper treats as "no values yet".
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Resolve both release secrets, creating and persisting any that are missing.
 */
export function ensureReleaseSecrets(options: EnsureSecretOptions = {}): ResolvedReleaseSecrets {
  const env = options.env ?? process.env;
  // `BUN_OPTIONS=--no-env-file` on the entry point disables `.env` auto-loading
  // for the whole `bun run` process tree, so any DOKAN_* value left in `env`
  // is a deliberate override and must be honoured even when it equals the
  // customer-less `.env` value (PR #117 finding 3). Without that proof an
  // ancestor may have pre-loaded `.env`, so the base-file heuristic below
  // stays in charge.
  const envIsExplicit =
    options.envIsExplicit ??
    (options.env === undefined && (process.env.BUN_OPTIONS ?? "").includes("--no-env-file"));
  const rawSlug = options.customerSlug ?? env.DOKAN_CUSTOMER_SLUG;
  const trimmedSlug = rawSlug?.trim();
  const slug = trimmedSlug === undefined || trimmedSlug === "" ? undefined : assertCustomerSlug(trimmedSlug);
  const envDir = options.envDir ?? RELEASE_ENV_DIR;
  const envFilePath = options.envFilePath ?? releaseEnvPathFor(slug, envDir);
  // A complete file restored from a backup can arrive with a loose mode; the
  // signing secret must not stay readable by other local users just because
  // nothing had to be regenerated (PR #117 re-review finding 3). Restrict on
  // every read path, before the values are read.
  restrictSecretFilePermissions(envFilePath);
  const baseEnvFilePath = path.join(path.dirname(envFilePath), RELEASE_ENV_FILENAME);
  if (slug !== undefined) restrictSecretFilePermissions(baseEnvFilePath);
  // The base `.env` is the customer-less build's set. Reading it lets a slugged
  // build recognise (and refuse) values `bun run` pre-loaded from it.
  const baseStored = slug === undefined ? {} : readEnvFile(baseEnvFilePath);
  // The outer `bun run desktop:*` process pre-loads the `.env` from ITS cwd
  // (the repo root) before the script sets BUN_OPTIONS. Those values are
  // inherited, not overrides, so a slugged build must ignore them too. The
  // check only applies to the real process environment; a caller-supplied
  // `env` (tests) has no outer process to inherit from.
  const ambientStored =
    slug === undefined
      ? {}
      : options.ambientEnvFilePath !== undefined
        ? readEnvFile(options.ambientEnvFilePath)
        : options.env !== undefined
          ? {}
          : {
              ...readEnvFile(path.resolve(RELEASE_ENV_DIR, "..", "..", RELEASE_ENV_FILENAME)),
              ...readEnvFile(path.resolve(RELEASE_ENV_DIR, "..", "..", ".env.local")),
            };

  const ctx: ResolveContext = {
    env,
    stored: readEnvFile(envFilePath),
    baseStored,
    ambientStored,
    envFilePath,
    slug,
    envIsExplicit,
    generate: options.generate ?? generateSecret,
  };

  let build = resolveOne(BUILD_SECRET_SPEC, ctx);
  let auth = resolveOne(AUTH_SECRET_SPEC, ctx);

  if (build.created || auth.created) {
    // First-time generation is a read-modify-write. Without a cross-process
    // lock, two builds racing a missing file generate different values, keep
    // different ones in memory, and the loser's rebuild changes the shipped
    // credentials (PR #117 finding 4). The lock makes the loser re-read and
    // reuse the winner's file.
    withGenerationLock(envFilePath, options, () => {
      ctx.stored = readEnvFile(envFilePath);
      build = resolveOne(BUILD_SECRET_SPEC, ctx);
      auth = resolveOne(AUTH_SECRET_SPEC, ctx);
      persistGenerated(ctx, build, auth);
    });
  }

  return {
    secrets: { DOKAN_BUILD_SECRET: build.value, DOKAN_AUTH_SECRET: auth.value },
    sources: { DOKAN_BUILD_SECRET: build.source, DOKAN_AUTH_SECRET: auth.source },
    generated: [build, auth].filter((one) => one.created).map((one) => one.key),
    customerSlug: slug,
    envFilePath,
  };
}

/** Persist just the generated keys; stored values are never re-serialised. */
function persistGenerated(ctx: ResolveContext, ...resolved: ResolvedOne[]): void {
  const values: EnvFileValues = {};
  for (const one of resolved) {
    if (one.created) values[one.key] = one.value;
  }
  if (Object.keys(values).length === 0) return;
  writeEnvFile(ctx.envFilePath, values, ctx.slug);
}

export interface FileLockOptions {
  waitMs?: number;
  retryMs?: number;
  staleMs?: number;
  /**
   * When set, touch the lock file this often while it is held, so a long build
   * (minutes) is never mistaken for a crashed owner and stolen.
   */
  refreshMs?: number;
}

/**
 * Acquire an exclusive cross-process lock (an `O_EXCL` lock file) and return
 * an idempotent release.
 *
 * The lock file carries an owner token, and release only unlinks a lock that
 * still holds its token: a process whose stale lock was stolen cannot delete
 * the new owner's lock on its way out. The mutual exclusion itself is the
 * atomic `wx` create; a lock older than `staleMs` is stolen so a crash cannot
 * wedge every later build.
 */
export function acquireFileLock(lockPath: string, options: FileLockOptions = {}): () => void {
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}.${randomBytes(8).toString("hex")}`;

  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      // SAFETY: openSync either succeeds or throws a Node-style error whose
      // `code` distinguishes "another process holds the lock" (EEXIST).
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (tryStealStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${lockPath} — another build step is still running; ` +
            "if nothing is running, delete that lock file and retry",
        );
      }
      sleepSync(retryMs);
    }
  }
  fs.writeSync(fd, token);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (options.refreshMs !== undefined) {
    refreshTimer = setInterval(() => {
      try {
        // only refresh a lock we still own: after a stale steal, touching the
        // thief's lock would keep it alive forever
        if (fs.readFileSync(lockPath, "utf8") === token) {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        }
      } catch {
        // released or stolen meanwhile
      }
    }, options.refreshMs);
    refreshTimer.unref();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch {
      // already released, or stolen as stale: never delete another owner's lock
    }
  };
}

function withGenerationLock<T>(envFilePath: string, options: EnsureSecretOptions, work: () => T): T {
  const release = acquireFileLock(`${envFilePath}${RELEASE_ENV_LOCK_SUFFIX}`, {
    waitMs: options.lockWaitMs,
    retryMs: options.lockRetryMs,
    staleMs: options.lockStaleMs,
  });
  try {
    return work();
  } finally {
    release();
  }
}

/**
 * Remove a lock whose owner died, without deleting a lock someone just made.
 *
 * Two waiters can both observe the same stale lock. The identity re-check
 * between the two stats means the second waiter sees the fresh lock the first
 * waiter created and backs off instead of unlinking it; only the tiny gap
 * between the last stat and the unlink remains, and an owner cannot create a
 * fresh lock in that gap without a scheduler preemption at that exact point.
 *
 * Returns true when the caller should retry the exclusive create.
 */
function tryStealStaleLock(lockPath: string, staleMs: number): boolean {
  let observed: fs.Stats;
  try {
    observed = fs.statSync(lockPath);
  } catch {
    return true; // vanished: the holder released it, retry the create
  }
  if (Date.now() - observed.mtimeMs <= staleMs) return false;

  let current: fs.Stats;
  try {
    current = fs.statSync(lockPath);
  } catch {
    return true;
  }
  if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs || current.size !== observed.size) {
    // someone else already stole it and created a fresh lock — leave it alone
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // another waiter won the unlink race
  }
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Temp path for the atomic env write. The name keeps the `.env.` prefix, so
 * `.gitignore`'s `.env.*` rule covers a crash leftover. The old `..env...tmp`
 * shape (the leading dot was added twice) did not match and `git add .` could
 * stage a secret-bearing temp file (PR #117 finding 4).
 */
export function envTempPath(envFilePath: string): string {
  return path.join(
    path.dirname(envFilePath),
    `${path.basename(envFilePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
}

/**
 * Write `values` into the env file, atomically.
 *
 * The temp file is created owner-only and renamed over the target, so readers
 * (including `bun run`'s own `.env` preload) never observe a half-written
 * file, and a pre-existing world-readable file is replaced with a 0600 one
 * instead of keeping its mode while gaining a secret (PR #117 findings 2/4).
 */
function writeEnvFile(envFilePath: string, values: EnvFileValues, slug: string | undefined): void {
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  const existing = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf8") : undefined;
  if (existing !== undefined) {
    // `mode` on write only applies when the file is created; restrict a
    // pre-existing file BEFORE the new secret lands in it.
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch {
      // best effort — Windows ACLs do not map to POSIX modes
    }
  }

  const content =
    existing === undefined ? renderEnvFile(values, releaseEnvHeader(slug)) : mergeEnvFile(existing, values);
  const tempPath = envTempPath(envFilePath);
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // best effort
    }
    fs.renameSync(tempPath, envFilePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
}
