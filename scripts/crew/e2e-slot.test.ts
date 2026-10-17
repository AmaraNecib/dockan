import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { slotSelftest } from "./e2e-slot";

const ROOT = join(import.meta.dir, "..", "..");
const SHIM = join(ROOT, ".scratch", "scripts", "e2e-slot.sh");

// The `--selftest` case list IS the test list: one source, so the operator's one-command
// proof cannot drift from what CI runs. A second copy of the cases is how a proof stops
// being a proof.
describe("e2e-slot", () => {
  test("--selftest cases all pass", async () => {
    const failed = (await slotSelftest()).filter((item) => !item.ok);
    expect(failed).toEqual([]);
  });

  // The stdout is a contract, not prose: `~/.pi/agent/extensions/e2e-slot-guard.ts`
  // reads `^PORTS (.+)$` and blocks a heavy run when the exit code is non-zero. This
  // goes through the SHIM, so a shim that stops forwarding fails here too.
  test("the shim prints the quartet the guard parses, and exits 2 with none free", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "crew-slot-test-"));
    const root = join(sandbox, "slots");
    const env = { ...process.env, E2E_SLOT_DIR: root, E2E_SLOTS: "1" };
    try {
      const granted = execFileSync("bash", [SHIM, "acquire", "lane-test", "--no-wait"], { encoding: "utf8", env, windowsHide: true });
      expect(granted).toMatch(/^PORT_SLOT=slot1 held by lane-test\nPORTS DOKAN_PORT=\d+ DOKAN_WEB_PORT=\d+ DOKAN_VAULT_PORT=\d+ DOKAN_VAULT_WEB_PORT=\d+\n$/u);
      const second = spawnSync("bash", [SHIM, "acquire", "lane-other", "--no-wait"], { encoding: "utf8", env, windowsHide: true });
      expect(second.status).toBe(2);
      expect(second.stdout).toMatch(/^PORT_SLOT=none \(lane-other still queued; held=1\/1\)\n$/u);
      const released = execFileSync("bash", [SHIM, "release", "lane-test"], { encoding: "utf8", env, windowsHide: true });
      expect(released).toBe("released slot1 from lane-test\n");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // The guard discovers the script BY NAME, so the name is load-bearing even though the
  // implementation moved. A missing shim disarms the cap with no error at all.
  test("the file e2e-slot-guard.ts walks up for still exists", () => {
    expect(existsSync(SHIM)).toBe(true);
    expect(existsSync(join(ROOT, ".scratch", "scripts", "crew-pickup.sh"))).toBe(true);
    mkdirSync(join(ROOT, ".scratch", "scripts"), { recursive: true });
  });
});
