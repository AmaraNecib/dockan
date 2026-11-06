import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type AttemptStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
export type ManifestTest = {
  id: string;
  titlePath: string[];
  location: { file: string };
  project: () => { name: string } | undefined;
  repeatEachIndex: number;
};
export type ManifestResult = {
  retry: number;
  status: AttemptStatus;
  expectedStatus: AttemptStatus;
  duration: number;
};
export type StringEnvironment = {
  DOKAN_PORT: string; DOKAN_WEB_PORT: string; DOKAN_VAULT_PORT: string; DOKAN_VAULT_WEB_PORT: string;
  DOKAN_APP_HOST: string; DOKAN_VAULT: string; E2E_SPECS: string;
  VITE_SCAN_DUPLICATE_WINDOW_MS: string; VITE_SCAN_MAX_GAP_MS: string;
};
export type BrowserProvenanceInput = {
  runId?: number | string | null; attempt?: number | string | null; event?: string | null; ref?: string | null;
  repository?: string | null; actor?: string | null; trustContext?: { EVENT?: string | null; REF?: string | null };
  checkoutSha?: string | null; checkoutTree?: string | null; workflowSha256?: string | null;
  playwrightConfigSha256?: string | null; lockSha256?: string | null; bunVersion?: string | null;
  nodeVersion?: string | null; playwrightVersion?: string | null; runnerOS?: string | null; runnerArch?: string | null;
  runnerImage?: string | null; runnerImageVersion?: string | null; appEnvironment?: Partial<StringEnvironment>;
  browserIdentity?: Partial<BrowserIdentity>; testConfig?: { WORKERS?: string; RETRIES?: string; LOCALE?: string };
};
export type BrowserIdentity = {
  ACTUAL_VERSION: string; ACTUAL_REVISION: string; EXECUTABLE_SHA256: string; PROVENANCE: string;
  EXPECTED_PACKAGE_REVISION: string; EXPECTED_PACKAGE_VERSION: string;
};
export type BrowserProvenance = {
  runId: number | "unknown"; attempt: number | "unknown"; event: string; ref: string; repository: string; actor: string;
  trustContext: { EVENT: string; REF: string }; checkoutSha: string; checkoutTree: string;
  workflowSha256: string; playwrightConfigSha256: string; lockSha256: string;
  bunVersion: string; nodeVersion: string; playwrightVersion: string;
  runnerOS: string; runnerArch: string; runnerImage: string; runnerImageVersion: string;
  appEnvironment: StringEnvironment; browserIdentity: BrowserIdentity;
  testConfig: { WORKERS: string; RETRIES: string; LOCALE: string };
};
export type BrowserManifest = {
  schemaVersion: 1;
  phase: "initializing" | "running" | "finalized" | "interrupted" | "collector-error";
  complete: boolean;
  noSafeReuseCertified: true;
  savedMinutes: 0;
  provenance: BrowserProvenance;
  inventory: { file: string; project: string; titlePath: string[]; repeatEachIndex: number; id: string }[];
  outcomes: { id: string; repeatEachIndex: number; attempts: { retry: number; status: AttemptStatus; expectedStatus: AttemptStatus; durationMs: number }[]; finalStatus: AttemptStatus | "unknown"; expectedStatus: AttemptStatus | "unknown"; unexpected: boolean | "unknown" }[];
  diagnostics: string[];
};

// eslint-disable-next-line no-control-regex -- Rejecting control bytes from serialized metadata is intentional.
const safeText = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]*$/u).catch("unknown");
// eslint-disable-next-line no-control-regex -- Rejecting control bytes from serialized metadata is intentional.
const safeFileText = z.string().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]*$/u);
const digestText = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu).transform((value) => value.toLowerCase()).catch("unknown");
const unknownNumber = z.union([z.number().int().positive().safe(), z.literal("unknown")]).catch("unknown");
const environmentSchema = z.object({
  DOKAN_PORT: safeText, DOKAN_WEB_PORT: safeText, DOKAN_VAULT_PORT: safeText, DOKAN_VAULT_WEB_PORT: safeText,
  DOKAN_APP_HOST: safeText, DOKAN_VAULT: safeText, E2E_SPECS: z.string().max(1024).catch("unknown"),
  VITE_SCAN_DUPLICATE_WINDOW_MS: safeText, VITE_SCAN_MAX_GAP_MS: safeText,
}).strip().catch({
  DOKAN_PORT: "unknown", DOKAN_WEB_PORT: "unknown", DOKAN_VAULT_PORT: "unknown", DOKAN_VAULT_WEB_PORT: "unknown",
  DOKAN_APP_HOST: "unknown", DOKAN_VAULT: "unknown", E2E_SPECS: "unknown",
  VITE_SCAN_DUPLICATE_WINDOW_MS: "unknown", VITE_SCAN_MAX_GAP_MS: "unknown",
});
const browserIdentitySchema = z.object({
  ACTUAL_VERSION: safeText, ACTUAL_REVISION: safeText, EXECUTABLE_SHA256: safeText, PROVENANCE: safeText,
  EXPECTED_PACKAGE_REVISION: safeText, EXPECTED_PACKAGE_VERSION: safeText,
}).strip().catch({
  ACTUAL_VERSION: "unknown", ACTUAL_REVISION: "unknown", EXECUTABLE_SHA256: "unknown", PROVENANCE: "unknown",
  EXPECTED_PACKAGE_REVISION: "unknown", EXPECTED_PACKAGE_VERSION: "unknown",
});
const provenanceSchema = z.object({
  runId: unknownNumber, attempt: unknownNumber,
  event: z.union([z.enum(["pull_request", "push", "workflow_dispatch"]), z.literal("unknown")]).catch("unknown"),
  ref: safeText, repository: safeText, actor: safeText,
  trustContext: z.object({ EVENT: safeText, REF: safeText }).strip().catch({ EVENT: "unknown", REF: "unknown" }),
  checkoutSha: digestText, checkoutTree: digestText, workflowSha256: digestText, playwrightConfigSha256: digestText, lockSha256: digestText,
  bunVersion: safeText, nodeVersion: safeText, playwrightVersion: safeText,
  runnerOS: safeText, runnerArch: safeText, runnerImage: safeText, runnerImageVersion: safeText,
  appEnvironment: environmentSchema, browserIdentity: browserIdentitySchema,
  testConfig: z.object({ WORKERS: safeText, RETRIES: safeText, LOCALE: safeText }).strip().catch({ WORKERS: "unknown", RETRIES: "unknown", LOCALE: "unknown" }),
}).strip();
const attemptSchema = z.object({ retry: z.number().int().nonnegative(), status: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]), expectedStatus: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]), duration: z.number().finite().nonnegative() });
const MAX_MANIFEST_BYTES = 256 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/u;

function safeRelativeFile(file: string, cwd: string): string | null {
  if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file)) return null;
  const normalized = path.posix.normalize(file.replace(/\\/gu, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function sanitizeProvenance(input: BrowserProvenanceInput | undefined): BrowserProvenance {
  return provenanceSchema.parse(input ?? {});
}

function normalizeTest(test: ManifestTest, cwd: string): BrowserManifest["inventory"][number] | null {
  const file = safeRelativeFile(test.location.file, cwd);
  const project = test.project()?.name;
  if (!file || !project || !test.id || test.id.length > 256 || !Number.isSafeInteger(test.repeatEachIndex) || test.repeatEachIndex < 0) return null;
  const parsedTitlePath = z.array(safeFileText).max(40).safeParse(test.titlePath);
  if (!parsedTitlePath.success) return null;
  const titlePath = parsedTitlePath.data;
  const repeatEachIndex = test.repeatEachIndex;
  return { file, project, titlePath, repeatEachIndex, id: test.id };
}

export type BrowserManifestInput = {
  discovered?: ManifestTest[];
  results?: { test: ManifestTest; result: ManifestResult }[];
  runStatus?: string | null;
  initialized?: boolean;
  finalized?: boolean;
  provenance?: BrowserProvenanceInput;
  cwd?: string;
  collectorError?: boolean;
};

export function createBrowserManifest(input: BrowserManifestInput): BrowserManifest {
  const cwd = input.cwd ?? process.cwd();
  const diagnostics: string[] = [];
  const tests = input.discovered ?? [];
  const inventory = tests.map((test) => normalizeTest(test, cwd)).filter((test): test is NonNullable<typeof test> => test !== null);
  if (inventory.length !== tests.length) diagnostics.push("some discovered tests had unsafe or malformed identities");
  const identityKey = (test: { id: string; repeatEachIndex: number }) => JSON.stringify([test.id, test.repeatEachIndex]);
  const identities = new Set(inventory.map(identityKey));
  if (identities.size !== inventory.length) diagnostics.push("duplicate discovered test identities");

  const grouped = new Map<string, ManifestResult[]>();
  for (const item of input.results ?? []) {
    const identity = normalizeTest(item.test, cwd);
    const key = identity ? identityKey(identity) : "";
    if (!identity || !identities.has(key)) {
      diagnostics.push("result did not match discovered inventory");
      continue;
    }
    const list = grouped.get(key) ?? [];
    const parsedResult = attemptSchema.safeParse(item.result);
    if (!parsedResult.success) {
      diagnostics.push("malformed test result");
      continue;
    }
    list.push(parsedResult.data);
    grouped.set(key, list);
  }
  const outcomes: BrowserManifest["outcomes"] = inventory.map(({ id, repeatEachIndex }) => {
    const attempts = (grouped.get(identityKey({ id, repeatEachIndex })) ?? []).slice().sort((a, b) => a.retry - b.retry).map((attempt) => ({
      retry: attempt.retry,
      status: attempt.status,
      expectedStatus: attempt.expectedStatus,
      durationMs: Math.round(attempt.duration),
    }));
    const last = attempts.at(-1);
    const finalStatus = last?.status ?? "unknown";
    const expectedStatus = last?.expectedStatus ?? "unknown";
    return { id, repeatEachIndex, attempts, finalStatus, expectedStatus, unexpected: last ? last.status !== last.expectedStatus : "unknown" };
  });
  const initialized = input.initialized === true;
  const finalized = input.finalized === true;
  const interrupted = input.runStatus === "interrupted" || input.runStatus === "timedout";
  const phase = input.collectorError ? "collector-error" : !initialized ? "initializing" : !finalized ? "running" : interrupted ? "interrupted" : "finalized";
  const successfulFinalization = input.runStatus === "passed" || input.runStatus === "failed";
  const complete = initialized && finalized && successfulFinalization && !interrupted && input.collectorError !== true && diagnostics.length === 0 && inventory.length === tests.length && outcomes.every((outcome) => outcome.attempts.length > 0 && outcome.attempts.every((attempt) => attempt.status !== "interrupted"));
  return {
    schemaVersion: 1,
    phase,
    complete,
    noSafeReuseCertified: true,
    savedMinutes: 0,
    provenance: sanitizeProvenance(input.provenance),
    inventory,
    outcomes,
    diagnostics,
  };
}

export function sha256File(filePath: string): string | "unknown" {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return "unknown";
  }
}

function assertNoSymlink(target: string, root: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("unsafe manifest destination");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("manifest destination contains a symlink");
    if (current !== target && !stat.isDirectory()) throw new Error("manifest destination parent is not a directory");
  }
}

export function writeManifestSafely(root: string, relativePath: string, manifest: BrowserManifest): number {
  const segments = relativePath.split(/[\\/]/u);
  if (segments.length < 2 || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") || segments.at(-1) !== "manifest.json") {
    throw new Error("unsafe manifest path");
  }
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...segments);
  assertNoSymlink(destination, resolvedRoot);
  mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlink(destination, resolvedRoot);
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("manifest exceeded 256 KiB limit");
  const temporary = `${destination}.${process.pid}.tmp`;
  if (existsSync(destination) || existsSync(temporary)) throw new Error("manifest destination already exists");
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, destination);
  return bytes.byteLength;
}
