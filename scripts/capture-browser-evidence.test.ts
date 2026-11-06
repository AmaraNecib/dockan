import { expect, it } from "bun:test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPortFree, capture, validateSource, waitReady } from "./capture-browser-evidence";
import { spawnOwnedServer, stopOwnedServer } from "../tests/e2e/owned-server-process";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function pinnedSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-evidence-source-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, "source.txt"), "pinned\n");
  git(root, "add", "source.txt");
  git(root, "commit", "-qm", "fixture");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

it("accepts only the exact clean source revision", async () => {
  const fixture = pinnedSource();
  try {
    expect(await validateSource(fixture.root, fixture.head)).toBe(fixture.head);
    await expect(validateSource(fixture.root, "0".repeat(40))).rejects.toThrow("Source revision mismatch");
    fs.writeFileSync(path.join(fixture.root, "dirty.txt"), "uncommitted");
    await expect(validateSource(fixture.root, fixture.head)).rejects.toThrow("Source tree is dirty");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

it("detects a port held by an unrelated listener instead of reusing it", async () => {
  const net = await import("node:net");
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (address === null) throw new Error("fixture listener has no TCP address");
  if (!(address instanceof Object)) throw new Error("fixture listener has no TCP port");
  const port = address.port;
  try {
    await expect(assertPortFree(port)).rejects.toThrow(`Port ${port} is occupied`);
  } finally { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); }
});

it("fails readiness immediately when its owned server exits", async () => {
  const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
  const child: ChildProcess = spawnOwnedServer(node, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await expect(waitReady("http://127.0.0.1:1/", child, 2_000)).rejects.toThrow("exited before readiness");
  await stopOwnedServer(child).catch(() => undefined);
});

it("rejects invalid TCP port values and identical before/after revisions", async () => {
  await expect(assertPortFree(0)).rejects.toThrow("Invalid TCP port");
  await expect(capture({ journey: "unused", source: "unused", revision: "a".repeat(40), against: "a".repeat(40), output: "unused", port: 4617 })).rejects.toThrow("must be distinct");
});
