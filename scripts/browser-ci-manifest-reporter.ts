import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { z } from "zod";
import { createBrowserManifest, sha256File, writeManifestSafely, type BrowserManifest, type BrowserProvenanceInput, type ManifestResult, type ManifestTest } from "./browser-ci-manifest";

function textOrUnknown(value: string | undefined): string {
  return value ?? "unknown";
}

function gitValue(root: string, ...args: string[]): string {
  try {
    const value = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}

function packageVersion(root: string): string {
  try {
    const packageJson = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u) }).safeParse(JSON.parse(readFileSync(path.join(root, "node_modules", "@playwright", "test", "package.json"), "utf8")));
    return packageJson.success ? packageJson.data.version : "unknown";
  } catch {
    return "unknown";
  }
}

function fileDigest(root: string, relative: string): string {
  const fullPath = path.join(root, relative);
  return existsSync(fullPath) ? sha256File(fullPath) : "unknown";
}

function manifestTest(test: TestCase, root: string): ManifestTest {
  return {
    id: test.id,
    titlePath: test.titlePath(),
    location: { file: path.relative(root, test.location.file) },
    project: () => ({ name: test.parent.project()?.name ?? "" }),
    repeatEachIndex: test.repeatEachIndex,
  };
}

function manifestResult(test: TestCase, result: TestResult): ManifestResult {
  const statuses = z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]);
  return {
    retry: result.retry,
    status: statuses.catch("interrupted").parse(result.status),
    expectedStatus: statuses.catch("interrupted").parse(test.expectedStatus),
    duration: result.duration,
  };
}

export default class BrowserManifestReporter implements Reporter {
  private root = process.cwd();
  private discovered: ManifestTest[] = [];
  private results: { test: ManifestTest; result: ManifestResult }[] = [];
  private provenance: BrowserProvenanceInput = {};
  private initialized = false;
  private finalized = false;
  private runStatus: string | null = null;
  private collectorError = false;
  private written = false;
  private readonly outputDirectory: string;

  constructor(options: { outputDirectory?: string } = {}) {
    this.outputDirectory = options.outputDirectory ?? process.env.BROWSER_CI_MANIFEST_DIR ?? "";
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.root = process.cwd();
    this.discovered = suite.allTests().map((test) => manifestTest(test, this.root));
    this.initialized = true;
    const env = process.env;
    const head = gitValue(this.root, "rev-parse", "HEAD");
    const tree = gitValue(this.root, "rev-parse", "HEAD^{tree}");
    const appEnvironment = {
      DOKAN_PORT: textOrUnknown(env.DOKAN_PORT),
      DOKAN_WEB_PORT: textOrUnknown(env.DOKAN_WEB_PORT),
      DOKAN_VAULT_PORT: textOrUnknown(env.DOKAN_VAULT_PORT),
      DOKAN_VAULT_WEB_PORT: textOrUnknown(env.DOKAN_VAULT_WEB_PORT),
      DOKAN_APP_HOST: textOrUnknown(env.DOKAN_APP_HOST),
      DOKAN_VAULT: textOrUnknown(env.DOKAN_VAULT),
      E2E_SPECS: env.E2E_SPECS === "" ? "full" : textOrUnknown(env.E2E_SPECS),
      VITE_SCAN_DUPLICATE_WINDOW_MS: textOrUnknown(env.VITE_SCAN_DUPLICATE_WINDOW_MS),
      VITE_SCAN_MAX_GAP_MS: textOrUnknown(env.VITE_SCAN_MAX_GAP_MS),
    };
    this.provenance = {
      runId: /^\d{1,20}$/u.test(env.GITHUB_RUN_ID ?? "") ? Number(env.GITHUB_RUN_ID) : "unknown",
      attempt: /^\d{1,6}$/u.test(env.GITHUB_RUN_ATTEMPT ?? "") ? Number(env.GITHUB_RUN_ATTEMPT) : "unknown",
      event: textOrUnknown(env.GITHUB_EVENT_NAME),
      ref: textOrUnknown(env.GITHUB_REF),
      repository: textOrUnknown(env.GITHUB_REPOSITORY),
      actor: textOrUnknown(env.GITHUB_ACTOR),
      trustContext: { EVENT: textOrUnknown(env.GITHUB_EVENT_NAME), REF: textOrUnknown(env.GITHUB_REF) },
      checkoutSha: head,
      checkoutTree: tree,
      workflowSha256: fileDigest(this.root, ".github/workflows/ci.yml"),
      playwrightConfigSha256: fileDigest(this.root, "playwright.config.ts"),
      lockSha256: fileDigest(this.root, "bun.lock"),
      bunVersion: textOrUnknown(process.versions.bun),
      nodeVersion: textOrUnknown(process.version),
      playwrightVersion: packageVersion(this.root),
      runnerOS: textOrUnknown(env.RUNNER_OS),
      runnerArch: textOrUnknown(env.RUNNER_ARCH),
      runnerImage: textOrUnknown(env.ImageOS),
      runnerImageVersion: textOrUnknown(env.ImageVersion),
      appEnvironment,
      browserIdentity: {
        ACTUAL_VERSION: "unknown",
        ACTUAL_REVISION: "unknown",
        EXECUTABLE_SHA256: "unknown",
        PROVENANCE: "runtime browser identity is not exposed by the configured reporter seam",
        EXPECTED_PACKAGE_REVISION: "unknown",
        EXPECTED_PACKAGE_VERSION: "unknown",
      },
      testConfig: {
        WORKERS: String(config.workers),
        RETRIES: String(config.projects[0]?.retries ?? "unknown"),
        LOCALE: String(config.projects[0]?.use.locale ?? "unknown"),
      },
    };
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.results.push({ test: manifestTest(test, this.root), result: manifestResult(test, result) });
  }

  onError(): void {
    this.collectorError = true;
  }

  onEnd(result: FullResult): void {
    this.runStatus = result.status;
    this.finalized = true;
    this.persist();
  }

  async onExit(): Promise<void> {
    if (!this.written) this.persist();
  }

  private persist(): void {
    if (this.written || !this.outputDirectory) return;
    const manifest: BrowserManifest = createBrowserManifest({
      discovered: this.discovered,
      results: this.results,
      runStatus: this.runStatus,
      initialized: this.initialized,
      finalized: this.finalized,
      provenance: this.provenance,
      cwd: this.root,
      collectorError: this.collectorError,
    });
    try {
      writeManifestSafely(this.root, path.join(this.outputDirectory, "manifest.json"), manifest);
      this.written = true;
    } catch {
      // Playwright swallows reporter errors. Keep this diagnostic fixed and nonsecret;
      // do not throw or return a status override that could mask the test command.
      console.error("browser evidence collector: incomplete (manifest write failed)");
    }
  }
}
