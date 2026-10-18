import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pidIsAlive, probePidLiveness } from "./pid-liveness";

/**
 * Issue #275 / ADR-0012: the pid probe proves liveness only when it does not
 * throw; `ESRCH` is gone and anything else (`EPERM` above all, which on
 * Windows also covers a pid that no longer runs) is inconclusive.
 */

function killError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const spies: { mockRestore(): void }[] = [];

function mockKill(impl: (pid: number, signal?: string | number) => boolean): void {
  // SAFETY: the spy is typed by fs/process's own overloads; the test only ever
  // exercises the number-signal probe path
  const spy = spyOn(process, "kill").mockImplementation(impl as typeof process.kill);
  spies.push(spy);
}

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("shared pid-liveness probe", () => {
  it("reads a probe that does not throw as alive", () => {
    mockKill(() => true);
    expect(probePidLiveness(4242)).toBe("alive");
    expect(pidIsAlive(4242)).toBe(true);
  });

  it("reads ESRCH as definitively gone", () => {
    mockKill(() => {
      throw killError("ESRCH");
    });
    expect(probePidLiveness(4242)).toBe("gone");
    expect(pidIsAlive(4242)).toBe(false);
  });

  it("reads EPERM as inconclusive, never as proof of life", () => {
    mockKill(() => {
      throw killError("EPERM");
    });
    expect(probePidLiveness(4242)).toBe("unknown");
    // the port record only takes over a pid the probe calls gone, so an
    // inconclusive probe keeps the recorded owner
    expect(pidIsAlive(4242)).toBe(true);
  });

  it("reads any other throw as inconclusive", () => {
    mockKill(() => {
      throw killError("EINVAL");
    });
    expect(probePidLiveness(4242)).toBe("unknown");
  });

  it("agrees with the OS for a live pid and a reaped one", async () => {
    expect(probePidLiveness(process.pid)).toBe("alive");
    const child = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(probePidLiveness(child.pid)).toBe("gone");
  });

  /**
   * The bug survived because two modules each read `process.kill` their own
   * way. Pin that neither site reaches around the shared helper again.
   */
  it("is the only place the two call sites probe a pid", () => {
    const libDir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["port-record.ts", path.join("vault", "lock.ts")]) {
      const source = fs.readFileSync(path.join(libDir, file), "utf8");
      // strip comments first: the docstrings legitimately explain the probe
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code).not.toContain("process.kill");
    }
  });
});
