import { expect, it } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnOwnedServer, stopOwnedServer, stopOwnedServers } from "../tests/e2e/owned-server-process";

// Resolve once; every fixture process uses the actual absolute Node executable.
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", cwd: process.cwd() }).trim();
const cwd = process.cwd();
async function started(child: ChildProcess): Promise<void> {
  const message = once(child, "message");
  await Promise.race([message, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Node fixture did not start")), 3_000);
    message.finally(() => clearTimeout(timer)).catch(() => {});
  })]);
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    return true;
  }
}
async function waitForGone(pid: number): Promise<void> {
  if (!await waitUntil(() => gone(pid), 3_000)) throw new Error(`Owned test grandchild ${pid} did not exit`);
}
async function waitUntil(check: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

it("stops an owned child and grandchild before removing only its fresh fixture", async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-owned-process-"));
  const pidFile = path.join(fresh, "grandchild.pid");
  const grandchild = `setInterval(() => {}, 1000); process.send('ready');`;
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { cwd: ${JSON.stringify(cwd)}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    grandchild.once('message', () => process.send('ready'));
    setInterval(() => {}, 1000);
  `;
  const child = spawnOwnedServer(node, ["-e", script], { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await started(child);
    const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(gone(grandchildPid)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    await stopOwnedServers([child, undefined]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(gone(grandchildPid)).toBe(true);
    fs.rmSync(fresh, { recursive: true });
    expect(fs.existsSync(fresh)).toBe(false);
    await stopOwnedServer(child);
  } finally {
    // Never remove this fresh fixture if shutdown fails.
    await stopOwnedServer(child);
  }
}, 12_000);

it("handles an already closed owned child and a failed spawn without waiting for a lost close event", async () => {
  const child = spawnOwnedServer(node, ["-e", ""], { cwd, stdio: "ignore" });
  await once(child, "close");
  if (process.platform === "win32") {
    await expect(stopOwnedServer(child)).rejects.toThrow("leader exited before a successful tree stop");
  } else {
    await stopOwnedServer(child);
    await stopOwnedServer(child);
  }
  const missing = spawnOwnedServer(path.join(cwd, ".scratch", "nonexistent-sol-fixture-executable"), [], { cwd, stdio: "ignore" });
  await stopOwnedServer(missing);
});

it.skipIf(process.platform !== "win32")("preserves the fixture when an owned Windows leader exits before tree stop", async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-owned-exited-leader-"));
  const readyFile = path.join(fresh, "grandchild.ready");
  const pidFile = path.join(fresh, "grandchild.pid");
  const grandchildScript = `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`;
  const parentScript = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { cwd: ${JSON.stringify(cwd)}, stdio: 'ignore', detached: true });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    const deadline = Date.now() + 3000;
    const poll = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(readyFile)})) { clearInterval(poll); process.send({ grandchildPid: grandchild.pid }); process.exit(0); }
      if (Date.now() > deadline) process.exit(1);
    }, 10);
  `;
  const child = spawnOwnedServer(node, ["-e", parentScript], { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let grandchildPid: number | undefined;
  try {
    const [message] = await once(child, "message");
    // SAFETY: The fixture parent sends this field only after spawn returns the grandchild's numeric PID.
    const { grandchildPid: reportedPid } = message as { grandchildPid: number };
    grandchildPid = reportedPid;
    await once(child, "close");
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(gone(grandchildPid)).toBe(false);
    await expect(stopOwnedServer(child)).rejects.toThrow("leader exited before a successful tree stop");
    expect(fs.existsSync(fresh)).toBe(true);
    expect(gone(grandchildPid)).toBe(false);
  } finally {
    if (grandchildPid === undefined && fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    if (grandchildPid !== undefined && !gone(grandchildPid)) {
      process.kill(grandchildPid, "SIGTERM");
      await waitForGone(grandchildPid);
    }
    await stopOwnedServer(child).catch(() => {});
    fs.rmSync(fresh, { recursive: true });
  }
}, 12_000);

it("refuses an unowned child and preserves data when either stop fails", async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-owned-failure-"));
  const unowned = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
  const owned = spawnOwnedServer(node, ["-e", "setInterval(() => {}, 1000); process.send('ready')"], { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await started(owned);
    await expect(stopOwnedServers([unowned, owned]).then(() => fs.rmSync(fresh, { recursive: true }))).rejects.toThrow("preserve fixture data");
    expect(fs.existsSync(fresh)).toBe(true);
    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    expect(unowned.exitCode).toBeNull();
  } finally {
    const closed = once(unowned, "close");
    unowned.kill();
    await closed;
    await stopOwnedServer(owned);
    fs.rmSync(fresh, { recursive: true });
  }
}, 12_000);

it.skipIf(process.platform === "win32")("escalates an owned POSIX group that ignores SIGTERM", async () => {
  const child = spawnOwnedServer(node, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"], { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await started(child);
    await stopOwnedServer(child);
    expect(child.signalCode).toBe("SIGKILL");
  } finally { await stopOwnedServer(child); }
}, 8_000);
