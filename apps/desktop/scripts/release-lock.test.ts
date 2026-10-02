import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.join(import.meta.dir, "release-lock.ts")).href;

function spawnWorker(lockPath: string, markers: string, id: string, holdMs: number) {
  const child = `
    const mod = await import(${JSON.stringify(moduleUrl)});
    await mod.withCheckoutReleaseLock(async () => {
      const fs = await import("node:fs");
      fs.appendFileSync(process.env.MARKERS, process.env.ID + "-start\\n");
      await Bun.sleep(Number(process.env.HOLD_MS));
      fs.appendFileSync(process.env.MARKERS, process.env.ID + "-end\\n");
    }, { lockPath: process.env.LOCK_PATH });
  `;
  return Bun.spawn(["bun", "-e", child], {
    cwd: import.meta.dir,
    env: { ...process.env, LOCK_PATH: lockPath, MARKERS: markers, ID: id, HOLD_MS: String(holdMs) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("withCheckoutReleaseLock (PR #117 re-review finding 2)", () => {
  it("serializes whole releases: the second waits for the first to finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-release-lock-"));
    const lockPath = path.join(dir, "release.lock");
    const markers = path.join(dir, "markers.txt");
    writeFileSync(markers, "");

    // without the checkout-wide lock these two critical sections interleave
    const first = spawnWorker(lockPath, markers, "A", 400);
    const second = spawnWorker(lockPath, markers, "B", 400);
    const [firstOut, firstErr, secondOut, secondErr, firstCode, secondCode] = await Promise.all([
      new Response(first.stdout).text(),
      new Response(first.stderr).text(),
      new Response(second.stdout).text(),
      new Response(second.stderr).text(),
      first.exited,
      second.exited,
    ]);
    if (firstCode !== 0 || secondCode !== 0) {
      throw new Error(`workers failed: ${firstCode}/${secondCode}\n${firstOut}\n${firstErr}\n${secondOut}\n${secondErr}`);
    }

    const lines = readFileSync(markers, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0].endsWith("-start")).toBe(true);
    expect(lines[1]).toBe(lines[0].replace("-start", "-end"));
    expect(lines[2].endsWith("-start")).toBe(true);
    expect(lines[3]).toBe(lines[2].replace("-start", "-end"));
    // the two sections belong to different workers
    expect(lines[0][0]).not.toBe(lines[2][0]);
  }, 20_000);

  it("releases the lock when the work throws", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-release-lock-"));
    const lockPath = path.join(dir, "release.lock");
    const child = `
      const mod = await import(${JSON.stringify(moduleUrl)});
      try {
        await mod.withCheckoutReleaseLock(async () => { throw new Error("boom"); }, { lockPath: process.env.LOCK_PATH });
      } catch {}
      await mod.withCheckoutReleaseLock(async () => {
        console.log("reacquired");
      }, { lockPath: process.env.LOCK_PATH });
    `;
    const proc = Bun.spawn(["bun", "-e", child], {
      cwd: import.meta.dir,
      env: { ...process.env, LOCK_PATH: lockPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`child failed: ${code}\n${err}`);
    expect(out).toContain("reacquired");
  }, 20_000);
});
