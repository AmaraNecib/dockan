import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPortFree, capture, convertAndValidateMedia, preflightExecutables, resolveServerCwd, runnerEnvironment, runFile, stopServersAndCleanData, validateComparisonManifest, validatePorts, validateReadinessUrl, validateServerContract, validateSource, runtimeUrls, verifySourceSnapshot } from "./capture-browser-evidence";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function pinnedSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser evidence source & "));
  git(root, "init", "-q"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, "source.txt"), "pinned\n"); git(root, "add", "source.txt"); git(root, "commit", "-qm", "fixture");
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
}, 20_000);

it("detects source mutation after the capture snapshot", async () => {
  const fixture = pinnedSource();
  try {
    const tree = git(fixture.root, "rev-parse", "HEAD^{tree}");
    fs.writeFileSync(path.join(fixture.root, "source.txt"), "changed during capture\n");
    await expect(verifySourceSnapshot(fixture.root, fixture.head, tree)).rejects.toThrow("identity or cleanliness changed");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}, 20_000);

it("passes argv literally and keeps cwd when spaces and shell metacharacters are present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argv cwd & spaces "));
  const marker = path.join(root, "shell-marker");
  const value = `literal & echo injected > ${marker}`;
  try {
    const output = await runFile(process.execPath, ["-e", "process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd()}))", value], root);
    expect(JSON.parse(output)).toEqual({ arg: value, cwd: root });
    expect(fs.existsSync(marker)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("uses Dokan's cookie-scoped host while retaining the allocated API and web ports", () => {
  expect(runtimeUrls({ api: 4617, web: 4618, vault: 4619, vaultWeb: 4620 })).toEqual({ api: "http://dokan.localhost:4617", web: "http://dokan.localhost:4618" });
});

it("requires an API and web process with readiness on each allocated listener", () => {
  const ports = { api: 4617, web: 4618, vault: 4619, vaultWeb: 4620 };
  const api = { name: "api" as const, command: "bun", args: ["src/main.ts"], cwd: "apps/api", readinessUrl: "http://127.0.0.1:{port}/api/vault/status" };
  const web = { name: "web" as const, command: "bun", args: ["run", "dev"], cwd: "apps/web", readinessUrl: "http://127.0.0.1:{port}/" };
  expect(() => validateServerContract([api, web], ports)).not.toThrow();
  expect(() => validateServerContract([api, { ...web, name: "api" }], ports)).toThrow("exactly one API server and one web server");
  expect(() => validateServerContract([api, { ...web, readinessUrl: "http://127.0.0.1:4999/" }], ports)).toThrow("allocated port 4618");
});

it("allocates four strict distinct ports and protects private data settings from journey overrides", () => {
  const ports = { api: 4617, web: 4618, vault: 4619, vaultWeb: 4620 };
  validatePorts(ports);
  expect(() => validatePorts({ ...ports, vaultWeb: 4617 })).toThrow("four lane ports");
  expect(runnerEnvironment(ports, "D:/private-runner-data", {}, { DOKAN_DATA_DIR: "D:/user-data", DOKAN_PORT: "4317" })).toEqual({ DOKAN_DATA_DIR: "D:/private-runner-data", DOKAN_PORT_ROOT: path.join("D:/private-runner-data", "run"), DOKAN_PORT: "4617", DOKAN_WEB_PORT: "4618", DOKAN_VAULT_PORT: "4619", DOKAN_VAULT_WEB_PORT: "4620" });
});

it("rejects a server cwd whose canonical path escapes the clean source root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-cwd-")), outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-cwd-"));
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveServerCwd(root, "escape")).rejects.toThrow("escapes the pinned source root");
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

it("accepts readiness only on loopback at the allocated port", () => {
  expect(validateReadinessUrl("http://127.0.0.1:{port}/health", 4617)).toBe("http://127.0.0.1:4617/health");
  expect(() => validateReadinessUrl("http://127.0.0.1:4618/health", 4617)).toThrow("allocated port 4617");
  expect(() => validateReadinessUrl("http://example.com:4617/health", 4617)).toThrow("loopback");
});

it("detects an occupied port instead of reusing its listener", async () => {
  const net = await import("node:net"), listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!(address instanceof Object)) throw new Error("fixture listener has no TCP address");
  try { await expect(assertPortFree(address.port)).rejects.toThrow(`Port ${address.port} is occupied`); }
  finally { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); }
});

it("rejects invalid ports and identical comparison revisions", async () => {
  const ports = { api: 4617, web: 4618, vault: 4619, vaultWeb: 4620 };
  await expect(capture({ journey: "unused", source: "unused", revision: "a".repeat(40), against: "a".repeat(40), output: "unused", ports })).rejects.toThrow("must be distinct");
  await expect(assertPortFree(0)).rejects.toThrow("Invalid TCP port");
});

it("preflights installed tools before server startup and propagates missing-tool errors", async () => {
  const calls: string[] = [];
  await expect(preflightExecutables(process.cwd(), async (command) => { calls.push(command); throw new Error(`${command} missing`); })).rejects.toThrow("ffmpeg missing");
  expect(calls).toEqual(["ffmpeg"]);
});

it("rejects NaN media metadata and propagates conversion errors", async () => {
  const calls: string[] = [];
  await expect(convertAndValidateMedia("recording.webm", "out", process.cwd(), async (command) => { calls.push(command); return "NaN"; })).rejects.toThrow("outside 30-45s");
  expect(calls).toEqual(["ffprobe"]);
  let conversionArgs: string[] = [];
  await expect(convertAndValidateMedia("recording.webm", "out", process.cwd(), async (command, args) => {
    if (command === "ffprobe" && args.includes("format=duration")) return "35.5";
    if (command === "ffmpeg") { conversionArgs = args; throw new Error("injected conversion failure"); }
    throw new Error("unexpected probe");
  })).rejects.toThrow("injected conversion failure");
  expect(conversionArgs).toContain("-crf");
  expect(conversionArgs).toContain("18");
});

it("rejects invalid converted duration and stream dimensions", async () => {
  let output: unknown;
  try { output = await convertAndValidateMedia("recording.webm", "out", process.cwd(), async (_command, args) => {
    if (args.includes("format=duration")) return args.includes("journey.mp4") ? "NaN" : "35.5";
    if (args.includes("-filter_complex") || args.includes("-c:v")) return "";
    if (args.includes("journey.gif")) return "video,960,540";
    return "video,1280,720";
  }); } catch (error) { output = error; }
  expect(output).toBeInstanceOf(Error);
  expect(output).toHaveProperty("message", expect.stringContaining("Converted evidence validation failed"));
});

it("preserves runner-owned data when owned server shutdown fails", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-data-"));
  const marker = path.join(dataDir, "fixture-marker"); fs.writeFileSync(marker, "keep while a process may still use it");
  try {
    await expect(stopServersAndCleanData([], dataDir, async () => { throw new Error("owned server did not stop"); })).rejects.toThrow("owned server did not stop");
    expect(fs.readFileSync(marker, "utf8")).toBe("keep while a process may still use it");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

it("writes a failed manifest for journey contract errors and preserves an output collision", async () => {
  const fixture = pinnedSource();
  const against = fixture.head;
  fs.writeFileSync(path.join(fixture.root, "source.txt"), "new revision\n"); git(fixture.root, "add", "source.txt"); git(fixture.root, "commit", "-qm", "capture revision");
  const revision = git(fixture.root, "rev-parse", "HEAD");
  const journey = path.join(os.tmpdir(), `invalid-journey-${Date.now()}.mjs`);
  const output = path.join(os.tmpdir(), `failed-capture-${Date.now()}`);
  const collision = path.join(os.tmpdir(), `evidence-collision-${Date.now()}`);
  fs.writeFileSync(journey, "export default { servers: [] };\n");
  const options = { journey, source: fixture.root, revision, against, output, ports: { api: 4711, web: 4712, vault: 4713, vaultWeb: 4714 } };
  try {
    await expect(capture(options)).rejects.toThrow("Journey must export API and web servers");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts["runner.log"].sha256).toMatch(/^[0-9a-f]{64}$/);
    fs.mkdirSync(collision); fs.writeFileSync(path.join(collision, "marker"), "keep this evidence");
    await expect(capture({ ...options, output: collision })).rejects.toThrow("refusing to overwrite evidence");
    expect(fs.readFileSync(path.join(collision, "marker"), "utf8")).toBe("keep this evidence");
  } finally { fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(collision, { recursive: true, force: true }); fs.rmSync(journey, { force: true }); fs.rmSync(fixture.root, { recursive: true, force: true }); }
}, 30_000);

it("requires the exact other revision in a distinct clean capture root", async () => {
  const before = pinnedSource(), after = pinnedSource();
  fs.writeFileSync(path.join(after.root, "later.txt"), "later\n"); git(after.root, "add", "later.txt"); git(after.root, "commit", "-qm", "later");
  after.head = git(after.root, "rev-parse", "HEAD");
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "verified-pair-"));
  const manifest = path.join(evidence, "manifest.json");
  const comparisonId = [before.head, after.head].sort().join("-");
  try {
    const artifacts: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ["journey.mp4", "journey.gif"]) { const content = `fixture ${name}`; fs.writeFileSync(path.join(evidence, name), content); artifacts[name] = { sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }; }
    fs.writeFileSync(manifest, JSON.stringify({ status: "passed", comparison: { id: comparisonId, revision: before.head }, source: { revision: before.head, tree: git(before.root, "rev-parse", "HEAD^{tree}"), clean: true, root: before.root }, artifacts }));
    await expect(validateComparisonManifest(manifest, before.head, comparisonId, after.root)).resolves.toBeUndefined();
    await expect(validateComparisonManifest(manifest, "f".repeat(40), comparisonId, after.root)).rejects.toThrow("exact --against revision");
    await expect(validateComparisonManifest(manifest, before.head, comparisonId, before.root)).rejects.toThrow("distinct source root");
  } finally { fs.rmSync(evidence, { recursive: true, force: true }); fs.rmSync(before.root, { recursive: true, force: true }); fs.rmSync(after.root, { recursive: true, force: true }); }
}, 20_000);
