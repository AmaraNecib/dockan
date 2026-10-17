import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The diff-proof the brief demands (rule 5), as a test rather than a transcript: the old
// shell script and the new TypeScript entry are run against the SAME seeded inputs and
// their stdout is compared byte for byte.
//
// Only the deterministic paths are here. `crew-pickup --dry-run`, `crew-clean --dry-run`
// and `crew-loop` read live state (the queue, the worktrees, herdr), so their old-vs-new
// diff is recorded in `.scratch/verification/262/<sha>-diffproof.md` with the command and
// the exact time it was taken; a test that depends on which lane happens to be running
// would be a flake dressed as a proof.
const ROOT = join(import.meta.dir, "..", "..");
const LEGACY = join(ROOT, ".scratch", "verification", "262", "legacy");

function findBash(): string | null {
  const suffixes = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `bash${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const BASH = findBash();

function seedSlots(): string {
  const root = join(mkdtempSync(join(tmpdir(), "crew-parity-")), "slots");
  mkdirSync(join(root, "held", "slot1"), { recursive: true });
  mkdirSync(join(root, "queue"), { recursive: true });
  writeFileSync(join(root, "held", "slot1", "lane"), "lane-x");
  writeFileSync(join(root, "held", "slot1", "since"), "2026-10-17T10:00:00Z");
  writeFileSync(join(root, "queue", "20200101T000000-1-lane-y.req"), "1700000000 lane-y\n");
  return root;
}

describe("legacy shell vs converted TypeScript", () => {
  test.skipIf(BASH === null)("e2e-slot status: identical byte for byte", () => {
    const root = seedSlots();
    // A long max-hold keeps both sides from reaping the fixture, so the comparison is
    // about the formatting, not about the clock.
    const env = { ...process.env, E2E_SLOT_DIR: root, E2E_SLOTS: "2", E2E_SLOT_MAX_HOLD: "999999" };
    try {
      const before = execFileSync(BASH ?? "bash", [join(LEGACY, "e2e-slot.sh"), "status"], { encoding: "utf8", env, windowsHide: true });
      const after = execFileSync(BASH ?? "bash", [join(ROOT, ".scratch", "scripts", "e2e-slot.sh"), "status"], { encoding: "utf8", env, windowsHide: true });
      expect(after).toBe(before);
      expect(before).toContain("  HELD  slot1  lane=lane-x since=2026-10-17T10:00:00Z");
      expect(before).toContain("  QUEUE 20200101T000000-1-lane-y lane=lane-y asked=1700000000");
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  test.skipIf(BASH === null)("e2e-slot release: identical, on two identical sandboxes", () => {
    const first = seedSlots();
    const second = seedSlots();
    try {
      const before = execFileSync(BASH ?? "bash", [join(LEGACY, "e2e-slot.sh"), "release", "lane-x"], {
        encoding: "utf8",
        env: { ...process.env, E2E_SLOT_DIR: first, E2E_SLOTS: "2" },
        windowsHide: true,
      });
      const after = execFileSync(BASH ?? "bash", [join(ROOT, ".scratch", "scripts", "e2e-slot.sh"), "release", "lane-x"], {
        encoding: "utf8",
        env: { ...process.env, E2E_SLOT_DIR: second, E2E_SLOTS: "2" },
        windowsHide: true,
      });
      expect(after).toBe(before);
      expect(before).toBe("released slot1 from lane-x\n");
    } finally {
      rmSync(dirname(first), { recursive: true, force: true });
      rmSync(dirname(second), { recursive: true, force: true });
    }
  });

  test.skipIf(BASH === null)("herdr-wake with no herdr: the same message and the same exit code", () => {
    // Only bash's own directory on PATH: no herdr anywhere, so both versions take the
    // "herdr not on PATH" branch, which is the exit code the whole policy hangs on. The
    // TypeScript side is run through bun directly, because a restricted PATH cannot
    // also carry `bun` for the shim's `exec bun`.
    const env = { ...process.env, PATH: dirname(BASH ?? "bash"), HERDR_BIN: "herdr" };
    const before = spawnSync(BASH ?? "bash", [join(LEGACY, "herdr-wake.sh"), "w48:p1", "hello", "1", "1"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    const after = spawnSync(process.execPath, [join(ROOT, "scripts", "crew", "herdr-wake.ts"), "w48:p1", "hello", "1", "1"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    expect(before.status).toBe(3);
    expect(after.status).toBe(3);
    expect(after.stderr).toBe(before.stderr);
    expect(before.stderr).toBe("herdr-wake: herdr not on PATH\n");
  });
});
