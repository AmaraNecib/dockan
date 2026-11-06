import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_TEST_DIR = "./tests/e2e";

// This is Playwright's default spec/test basename contract made explicit. Keep
// config and discovery on this same expression; no third-party glob parser is
// needed in the dependency-free changes job.
export const E2E_TEST_MATCH = /.*\.(spec|test)\.(?:[cm]?[jt]sx?)$/u;

export type Discovery = { ok: true; specs: string[] } | { ok: false; reason: string };

export function isRunnableE2eSpec(path: string): boolean {
  return E2E_TEST_MATCH.test(path.replace(/\\/gu, "/").split("/").at(-1) ?? "");
}

function supportedConfig(root: string): { ok: true } | { ok: false; reason: string } {
  const path = join(root, "playwright.config.ts");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read Playwright discovery config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (source.includes("testIgnore") || source.includes("projects:")) {
    return { ok: false, reason: `unsupported Playwright discovery config: testIgnore and project overrides are not modeled` };
  }
  const required = [
    'import { E2E_TEST_MATCH } from "./scripts/e2e-discovery";',
    `testDir: "${E2E_TEST_DIR}"`,
    "testMatch: E2E_TEST_MATCH",
    "respectGitIgnore: false",
  ];
  const missing = required.find((line) => !source.includes(line));
  return missing === undefined
    ? { ok: true }
    : { ok: false, reason: `unsupported Playwright discovery config: missing ${missing}` };
}

/**
 * Enumerate test candidates using the exact explicit config contract. Git ignore
 * rules are intentionally irrelevant: Playwright has an explicit testDir and
 * `respectGitIgnore` is false, so ignored files there remain runnable.
 */
export function discoverE2eSpecs(root = ROOT): Discovery {
  const config = supportedConfig(root);
  if (!config.ok) return config;

  const testRoot = join(root, E2E_TEST_DIR.slice(2));
  const specs: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && isRunnableE2eSpec(entry.name)) {
        specs.push(relative(testRoot, path).split(sep).join("/"));
      }
    }
  };

  try {
    visit(testRoot);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot enumerate Playwright test directory ${testRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  specs.sort();
  return specs.length === 0
    ? { ok: false, reason: `Playwright discovery found no runnable specs under ${testRoot}` }
    : { ok: true, specs };
}
