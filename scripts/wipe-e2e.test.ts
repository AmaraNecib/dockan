/**
 * L342: wipe-e2e.mjs recursively removes the path named by `$E2E_DATA_DIR`.
 * The CLI must refuse a physical target outside the working directory or the
 * working directory itself. For a missing target, resolve the nearest existing
 * ancestor before applying the same containment check.
 *
 * The tests spawn the script the way Playwright does (env + cwd), so the code
 * under test is the CLI the server actually runs, module and all. Every fixture
 * lives under a test-owned directory in the OS temp folder; where the baseline
 * script deletes a sentinel, the sentinel is disposable test data.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const WIPE_SCRIPT = fileURLToPath(new URL("./wipe-e2e.mjs", import.meta.url));

type Run = { code: number; out: string };

function runWipe(cwd: string, e2eDataDir: string): Promise<Run> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("node", [WIPE_SCRIPT], {
      cwd,
      env: { ...process.env, E2E_DATA_DIR: e2eDataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** The caller's working directory, as the script sees it via `process.cwd()`. */
const WALLET = mkdtempSync(join(tmpdir(), "wipe-e2e-test-"));

/** One `.e2e-data` shard with a file in it, the smallest tree a delete can hit. */
function makeDataDir(parent: string): string {
  const dataDir = join(parent, ".e2e-data");
  mkdirSync(join(dataDir, "takes"), { recursive: true });
  writeFileSync(join(dataDir, "takes", "records.db"), "data");
  return dataDir;
}

describe("wipe-e2e: the data dir the script agrees to delete", () => {
  // red-on-parent-waive: "deletes an .e2e-data dir that sits strictly inside the working directory" — the parent's script deletes an inside-cwd data dir too: this row is the positive control that the gate does not over-refuse, it pins behaviour the change kept, not behaviour it added
  test("deletes an .e2e-data dir that sits strictly inside the working directory", async () => {
    const dataDir = makeDataDir(WALLET);
    const run = await runWipe(WALLET, dataDir);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("refusing");
    expect(existsSync(join(dataDir, "takes", "records.db"))).toBe(false);
  });

  test("refuses a data dir outside the working directory, and leaves it intact", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wipe-e2e-outside-"));
    try {
      const dataDir = makeDataDir(outside);
      const run = await runWipe(WALLET, dataDir);
      // The evidence is the file, not the exit code alone: the delete must not
      // have happened, whatever the message says. The pre-fix script deletes it.
      const intact = existsSync(join(dataDir, "takes", "records.db"));
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing");
      expect(intact).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Node CLI cleans in-worktree data but refuses a final symlink to source", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "wipe-e2e-internal-link-"));
    const worktree = join(fixture, "worktree");
    const contracts = join(worktree, "packages", "contracts");
    try {
      mkdirSync(contracts, { recursive: true });
      const ordinaryData = makeDataDir(join(worktree, "ordinary"));
      const ordinaryRun = await runWipe(worktree, "ordinary/.e2e-data");
      expect(ordinaryRun.code).toBe(0);
      expect(existsSync(join(ordinaryData, "takes", "records.db"))).toBe(false);

      const sentinel = join(contracts, "source.ts");
      writeFileSync(sentinel, "contract source");
      symlinkSync(contracts, join(worktree, ".e2e-data"), process.platform === "win32" ? "junction" : "dir");

      const run = await runWipe(worktree, ".e2e-data");
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("refuses an in-worktree symlink ancestor and preserves its target", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "wipe-e2e-internal-ancestor-"));
    const worktree = join(fixture, "worktree");
    const contracts = join(worktree, "packages", "contracts");
    try {
      mkdirSync(contracts, { recursive: true });
      const dataDir = makeDataDir(contracts);
      const sentinel = join(dataDir, "takes", "records.db");
      symlinkSync(contracts, join(worktree, "alias"), process.platform === "win32" ? "junction" : "dir");

      const run = await runWipe(worktree, "alias/.e2e-data");
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked path into an external fixture and preserves its sentinel", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "wipe-e2e-symlink-"));
    const worktree = join(fixture, "worktree");
    const external = join(fixture, "external");
    try {
      mkdirSync(worktree);
      mkdirSync(external);
      const dataDir = makeDataDir(external);
      const sentinel = join(dataDir, "takes", "records.db");
      symlinkSync(external, join(worktree, "link"), process.platform === "win32" ? "junction" : "dir");
      const sentinelBefore = existsSync(sentinel);
      expect(sentinelBefore).toBe(true);

      const run = await runWipe(worktree, "link/.e2e-data");
      expect(run.code).toBe(1);
      const intact = existsSync(sentinel);
      expect(intact, `external fixture sentinel was removed: ${sentinel}`).toBe(true);
      expect(run.out).toContain("refusing");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("refuses a nonexistent target beneath a symlink into an external fixture", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "wipe-e2e-missing-symlink-"));
    const worktree = join(fixture, "worktree");
    const external = join(fixture, "external");
    try {
      mkdirSync(worktree);
      mkdirSync(external);
      writeFileSync(join(external, "sentinel.txt"), "keep fixture data");
      symlinkSync(external, join(worktree, "link"), process.platform === "win32" ? "junction" : "dir");
      const sentinel = join(external, "sentinel.txt");
      expect(existsSync(sentinel)).toBe(true);

      const run = await runWipe(worktree, "link/not-created/.e2e-data");
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("refuses the working directory itself as the data dir", async () => {
    mkdirSync(WALLET, { recursive: true }); // a prior test's cleanup may have taken it
    const wd = mkdtempSync(join(WALLET, "wd-"));
    writeFileSync(join(wd, "sentinel.db"), "keep me");
    const run = await runWipe(wd, wd);
    // The pre-fix script rmSync's the working directory itself, sentinel and
    // all; every later test re-creates the wallet shard it owns.
    const intact = existsSync(join(wd, "sentinel.db"));
    rmSync(WALLET, { recursive: true, force: true });
    expect(run.code).toBe(1);
    expect(run.out).toContain("refusing");
    expect(intact).toBe(true);
  });

  test("refuses a traversal target outside the working directory and preserves it", async () => {
    // Keep the target outside cwd but separate from cwd's ancestors. The old
    // script deletes the disposable target, without deleting its own cwd while
    // the child process and test runner still need it.
    const fixture = mkdtempSync(join(tmpdir(), "wipe-e2e-traversal-"));
    const wd = join(fixture, "worktree");
    const outside = join(fixture, "outside");
    mkdirSync(wd);
    mkdirSync(outside);
    const dataDir = makeDataDir(outside);
    const sentinel = join(dataDir, "takes", "records.db");
    try {
      const run = await runWipe(wd, "../outside/.e2e-data");
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // The OS temp directory must not keep this test's wallet fixture.
    rmSync(WALLET, { recursive: true, force: true });
  });
});
