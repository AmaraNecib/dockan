/**
 * Release secrets with a stable, editable default (issue: release ergonomics).
 *
 * The per-customer secrets used to be required on the build command line. They
 * now live in a gitignored `apps/desktop/.env`, exactly like `DOKAN_DATA_DIR`
 * and `DOKAN_PORT` have defaults: the pipeline reads them, and generates them
 * once if they are not there yet.
 *
 * Precedence, and why:
 *   1. an explicit environment variable — for the one build that needs a
 *      specific shop's secret, without rewriting the file;
 *   2. the value already in `apps/desktop/.env` — so a rebuild is stable;
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
export const RELEASE_ENV_PATH = path.resolve(RELEASE_ENV_FILENAME);

/** Printed at the top of a generated env file. */
export const RELEASE_ENV_HEADER = [
  "# Per-customer release secrets — GITIGNORED, never commit this file.",
  "#",
  "# Generated once and then reused on every build. Keep a copy per customer:",
  "# rebuilding for a shop needs the SAME two values, or that shop can no",
  "# longer reset its owner password and its sessions stop verifying.",
  "#",
  "# To change one, edit it here. To override for a single build, pass it on the",
  "# command line (DOKAN_AUTH_SECRET=... bun run desktop:portable).",
].join("\n");

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

export type SecretSource = "env" | "file" | "generated";

export type ReleaseSecretKey = "DOKAN_BUILD_SECRET" | "DOKAN_AUTH_SECRET";

export interface ResolvedReleaseSecrets {
  secrets: { DOKAN_BUILD_SECRET: string; DOKAN_AUTH_SECRET: string };
  sources: { DOKAN_BUILD_SECRET: SecretSource; DOKAN_AUTH_SECRET: SecretSource };
  /** Keys that were missing everywhere and had to be created. */
  generated: ReleaseSecretKey[];
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
  envFilePath: string;
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
    const check = spec.validate({ [spec.key]: explicit });
    if (!check.ok) throw new Error(`${spec.key}: ${check.reason}`);
    // `bun run` loads apps/desktop/.env into process.env before this script
    // starts, so an env value that MATCHES the file came from the file. Only a
    // differing value is a genuine override — reporting it as "env" otherwise
    // would tell the owner to edit a file the pipeline claims to ignore.
    const source: SecretSource = ctx.stored[spec.key] === explicit ? "file" : "env";
    return { key: spec.key, value: explicit, source, created: false };
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
  envFilePath?: string;
  generate?: (len: number) => string;
}

/**
 * Resolve both release secrets, creating and persisting any that are missing.
 */
export function ensureReleaseSecrets(options: EnsureSecretOptions = {}): ResolvedReleaseSecrets {
  const ctx: ResolveContext = {
    env: options.env ?? process.env,
    envFilePath: options.envFilePath ?? RELEASE_ENV_PATH,
    generate: options.generate ?? generateSecret,
    stored: {},
  };
  ctx.stored = fs.existsSync(ctx.envFilePath) ? parseEnvFile(fs.readFileSync(ctx.envFilePath, "utf8")) : {};

  const build = resolveOne(BUILD_SECRET_SPEC, ctx);
  const auth = resolveOne(AUTH_SECRET_SPEC, ctx);

  const toPersist: EnvFileValues = {};
  for (const one of [build, auth]) {
    if (one.created) toPersist[one.key] = one.value;
  }
  if (Object.keys(toPersist).length > 0) {
    // merge, so anything else the file holds survives a regeneration
    fs.mkdirSync(path.dirname(ctx.envFilePath), { recursive: true });
    fs.writeFileSync(ctx.envFilePath, renderEnvFile({ ...ctx.stored, ...toPersist }, RELEASE_ENV_HEADER), {
      mode: 0o600,
    });
  }

  return {
    secrets: { DOKAN_BUILD_SECRET: build.value, DOKAN_AUTH_SECRET: auth.value },
    sources: { DOKAN_BUILD_SECRET: build.source, DOKAN_AUTH_SECRET: auth.source },
    generated: [build, auth].filter((one) => one.created).map((one) => one.key),
  };
}
