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

/** Read `KEY=value` lines, ignoring blanks and comments. Quotes are stripped. */
export function parseEnvFile(text: string): EnvFileValues {
  const values: EnvFileValues = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (key !== "") values[key] = value;
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

/** The `KEY` of a `KEY=value` line, or undefined for comments/blanks. */
function envLineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return undefined;
  const key = trimmed.slice(0, eq).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : undefined;
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
    const key = envLineKey(body[i]);
    if (key === undefined || !Object.hasOwn(values, key)) continue;
    body[i] = `${key}=${values[key]}`;
    written.add(key);
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
  envFilePath: string;
  slug: string | undefined;
  generate: (len: number) => string;
}

/**
 * One secret, by precedence: an explicit environment variable, then the stored
 * value, then a freshly generated one. A value that is present but weak is
 * fatal — a default may be generated, a weak one must never ship.
 */
function resolveOne(spec: SecretSpec, ctx: ResolveContext): ResolvedOne {
  const explicit = ctx.env[spec.key];
  if (explicit !== undefined && explicit !== "") {
    // `bun run` pre-loads the customer-less `.env` into process.env. For a
    // slugged build that value belongs to whoever last built without a slug,
    // NOT to this customer, so it must not be mistaken for an override
    // (PR #117 finding 1). Only a value that is not the base file's own value
    // — and is not this customer's stored value — is a genuine override.
    const fromTargetFile = ctx.stored[spec.key] === explicit;
    const fromBaseFile = ctx.baseStored[spec.key] === explicit;
    if (fromTargetFile || !fromBaseFile) {
      const check = spec.validate({ [spec.key]: explicit });
      if (!check.ok) throw new Error(`${spec.key}: ${check.reason}`);
      // An env value that MATCHES the file came from the file; call it "file"
      // so the owner is pointed at the place to edit.
      return { key: spec.key, value: explicit, source: fromTargetFile ? "file" : "env", created: false };
    }
  }

  const fromFile = ctx.stored[spec.key];
  if (fromFile !== undefined && fromFile !== "") {
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
  generate?: (len: number) => string;
  /** Test seams for the cross-process generation lock. */
  lockWaitMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
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
  const rawSlug = options.customerSlug ?? env.DOKAN_CUSTOMER_SLUG;
  const trimmedSlug = rawSlug?.trim();
  const slug = trimmedSlug === undefined || trimmedSlug === "" ? undefined : assertCustomerSlug(trimmedSlug);

  const envDir = options.envDir ?? RELEASE_ENV_DIR;
  const envFilePath = options.envFilePath ?? releaseEnvPathFor(slug, envDir);
  // The base `.env` is the customer-less build's set. Reading it lets a slugged
  // build recognise (and refuse) values `bun run` pre-loaded from it.
  const baseStored =
    slug === undefined ? {} : readEnvFile(path.join(path.dirname(envFilePath), RELEASE_ENV_FILENAME));

  const ctx: ResolveContext = {
    env,
    stored: readEnvFile(envFilePath),
    baseStored,
    envFilePath,
    slug,
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

function withGenerationLock<T>(envFilePath: string, options: EnsureSecretOptions, work: () => T): T {
  const lockPath = `${envFilePath}${RELEASE_ENV_LOCK_SUFFIX}`;
  const retryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
  const staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      // SAFETY: openSync either succeeds or throws a Node-style error whose
      // `code` distinguishes "another process holds the lock" (EEXIST).
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStaleLock(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // another waiter removed it first — retry the create
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${lockPath} — another release-secret generation is still running; ` +
            "if no build is running, delete that lock file and retry",
        );
      }
      sleepSync(retryMs);
    }
  }

  try {
    return work();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // stolen as stale; nothing left to release
    }
  }
}

function isStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    // vanished between EEXIST and stat: the holder released it
    return true;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  const tempPath = path.join(
    path.dirname(envFilePath),
    `.${path.basename(envFilePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
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
