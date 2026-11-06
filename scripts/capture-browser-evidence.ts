import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { stopOwnedServers, spawnOwnedServer } from "../tests/e2e/owned-server-process";

export type EvidenceRuntime = { urls: { api: string; web: string }; ports: { api: number; web: number; vault: number; vaultWeb: number } };
export type EvidenceServer = { name: "api" | "web"; command: string; args: string[]; cwd: string; readinessUrl: string; env?: Record<string, string> };
export type EvidenceJourney = {
  servers: EvidenceServer[];
  setup?(page: Page, runtime: EvidenceRuntime): Promise<void>;
  journey(page: Page, evidence: { screenshotElement(name: string, selector: string): Promise<string> }, runtime: EvidenceRuntime): Promise<void>;
};
export type CaptureOptions = { journey: string; source: string; revision: string; against: string; output: string; ports: EvidenceRuntime["ports"]; comparisonManifest?: string };
type Options = CaptureOptions;
const VIEWPORT = { width: 1920, height: 1080 };
const MIN_SECONDS = 30;
const MAX_SECONDS = 45;

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new Error(`Expected unique --name value arguments; invalid argument: ${key ?? "<missing>"}`);
    values.set(key, value);
  }
  const required = (key: string): string => { const value = values.get(key); if (!value) throw new Error(`Missing required ${key}`); return value; };
  const ports = { api: Number(required("--api-port")), web: Number(required("--web-port")), vault: Number(required("--vault-port")), vaultWeb: Number(required("--vault-web-port")) };
  if (Object.values(ports).some((p) => !Number.isInteger(p) || p < 1 || p > 65535) || new Set(Object.values(ports)).size !== 4) throw new Error("All four lane ports must be distinct TCP ports from 1 to 65535");
  const comparisonManifest = values.get("--comparison-manifest");
  return { journey: path.resolve(required("--journey")), source: path.resolve(required("--source")), revision: required("--revision"), against: required("--against"), output: path.resolve(required("--output")), ports, comparisonManifest: comparisonManifest ? path.resolve(comparisonManifest) : undefined };
}
export function runFile(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr.trim()}`)));
  });
}
async function sha256(file: string): Promise<string> { return createHash("sha256").update(await fs.promises.readFile(file)).digest("hex"); }
export async function validateSource(source: string, revision: string): Promise<string> {
  const canonical = await fs.promises.realpath(source);
  const head = await runFile("git", ["rev-parse", "HEAD"], canonical);
  if (head !== revision) throw new Error(`Source revision mismatch: expected ${revision}, found ${head}`);
  const dirty = await runFile("git", ["status", "--porcelain"], canonical);
  if (dirty) throw new Error(`Source tree is dirty; refusing evidence capture:\n${dirty}`);
  return head;
}
export async function verifySourceSnapshot(source: string, expectedHead: string, expectedTree: string): Promise<{ head: string; tree: string; clean: string }> {
  const canonical = await fs.promises.realpath(source);
  const [head, tree, clean] = await Promise.all([
    runFile("git", ["rev-parse", "HEAD"], canonical).catch(() => "unavailable"),
    runFile("git", ["rev-parse", "HEAD^{tree}"], canonical).catch(() => "unavailable"),
    runFile("git", ["status", "--porcelain"], canonical).catch(() => "unavailable"),
  ]);
  if (head !== expectedHead || tree !== expectedTree || clean !== "") throw new Error("Source identity or cleanliness changed during capture");
  return { head, tree, clean };
}
export async function assertPortFree(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TCP port: ${port}`);
  await new Promise<void>((resolve, reject) => { const server = createServer(); server.once("error", () => reject(new Error(`Port ${port} is occupied; runner will not reuse a listener`))); server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve())); });
}
export function validateReadinessUrl(value: string, port: number): string {
  let url: URL; try { url = new URL(value.replaceAll("{port}", String(port))); } catch { throw new Error(`Invalid readiness URL: ${value}`); }
  if (!(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") || Number(url.port) !== port) throw new Error(`Readiness URL must use loopback and the allocated port ${port}: ${url.href}`);
  return url.href;
}
async function waitReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned server exited before readiness (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }); if (response.ok) return; } catch { /* retry until the bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server readiness timed out at ${url}`);
}
function artifactName(name: string): string { if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) throw new Error(`Invalid screenshot name: ${name}`); return name; }
export async function preflightExecutables(cwd: string, run: typeof runFile = runFile): Promise<void> {
  await run("ffmpeg", ["-version"], cwd);
  await run("ffprobe", ["-version"], cwd);
}
export async function convertAndValidateMedia(webm: string, output: string, cwd: string, run: typeof runFile = runFile): Promise<{ mp4: string; gif: string; duration: number }> {
  const duration = Number(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", webm], cwd));
  if (!Number.isFinite(duration) || duration < MIN_SECONDS || duration > MAX_SECONDS) throw new Error(`Recorded journey duration ${duration}s is outside ${MIN_SECONDS}-${MAX_SECONDS}s; use real visible interaction, never padding or speed changes`);
  const mp4 = path.join(output, "journey.mp4"), gif = path.join(output, "journey.gif");
  await run("ffmpeg", ["-i", webm, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mp4], cwd);
  await run("ffmpeg", ["-i", webm, "-filter_complex", "[0:v] fps=15,scale=960:-1:flags=lanczos,split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer", gif], cwd);
  const mp4Duration = Number(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4], cwd));
  const mp4Info = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", mp4], cwd);
  const gifInfo = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", gif], cwd);
  if (!Number.isFinite(mp4Duration) || mp4Duration < MIN_SECONDS || mp4Duration > MAX_SECONDS || mp4Info !== "video,1920,1080" || gifInfo !== "video,960,540") throw new Error(`Converted evidence validation failed: duration=${mp4Duration}s, mp4=${mp4Info}, gif=${gifInfo}`);
  return { mp4, gif, duration };
}
export function runtimeUrls(ports: EvidenceRuntime["ports"]): EvidenceRuntime["urls"] {
  return { api: `http://dokan.localhost:${ports.api}`, web: `http://dokan.localhost:${ports.web}` };
}
export function validatePorts(ports: EvidenceRuntime["ports"]): void {
  const values = Object.values(ports);
  if (values.length !== 4 || values.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) || new Set(values).size !== 4) throw new Error("All four lane ports must be distinct valid TCP ports");
}
export function validateServerContract(servers: EvidenceServer[], ports: EvidenceRuntime["ports"]): void {
  const names = servers.map((server) => server.name);
  if (servers.length !== 2 || new Set(names).size !== 2 || !names.includes("api") || !names.includes("web")) throw new Error("Journey must define exactly one API server and one web server");
  for (const server of servers) {
    if (!server.command || !Array.isArray(server.args) || !server.cwd || !server.readinessUrl) throw new Error(`Invalid ${server.name} server definition`);
    validateReadinessUrl(server.readinessUrl, server.name === "api" ? ports.api : ports.web);
  }
}
export function runnerEnvironment(ports: EvidenceRuntime["ports"], dataDir: string, inherited: NodeJS.ProcessEnv = process.env, journeyEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...inherited, ...journeyEnv, DOKAN_DATA_DIR: dataDir, DOKAN_PORT_ROOT: path.join(dataDir, "run"), DOKAN_PORT: String(ports.api), DOKAN_WEB_PORT: String(ports.web), DOKAN_VAULT_PORT: String(ports.vault), DOKAN_VAULT_WEB_PORT: String(ports.vaultWeb) };
}
function within(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
export async function resolveServerCwd(source: string, cwd: string): Promise<string> {
  const canonicalSource = await fs.promises.realpath(source);
  const canonicalCwd = await fs.promises.realpath(path.resolve(canonicalSource, cwd));
  if (!within(canonicalSource, canonicalCwd)) throw new Error(`Server cwd escapes the pinned source root: ${cwd}`);
  return canonicalCwd;
}
export async function stopServersAndCleanData(children: ChildProcess[], dataDir: string, stop: typeof stopOwnedServers = stopOwnedServers): Promise<void> {
  await stop(children);
  if (fs.existsSync(dataDir)) await fs.promises.rm(dataDir, { recursive: true, force: false });
}
export type ComparisonSnapshot = { path: string; sha256: string; source: { root: string; revision: string; tree: string }; artifacts: Record<string, { sha256: string; bytes: number }> };
export async function verifyComparisonUnchanged(snapshot: ComparisonSnapshot): Promise<void> {
  if (await sha256(snapshot.path) !== snapshot.sha256) throw new Error("Comparison manifest changed during capture");
  for (const [name, record] of Object.entries(snapshot.artifacts)) {
    const file = path.join(path.dirname(snapshot.path), name);
    if (await sha256(file) !== record.sha256 || (await fs.promises.stat(file)).size !== record.bytes) throw new Error(`Comparison artifact changed during capture: ${name}`);
  }
}
export async function validateComparisonManifest(file: string, against: string, comparisonId: string, currentRoot: string): Promise<ComparisonSnapshot> {
  const canonicalFile = await fs.promises.realpath(file);
  const bytes = await fs.promises.readFile(canonicalFile);
  // SAFETY: the manifest is untrusted input; every required field is checked below before use.
  const manifest = JSON.parse(bytes.toString("utf8")) as { status?: string; comparison?: { id?: string; revision?: string; against?: string }; source?: { revision?: string; tree?: string; clean?: boolean; root?: string }; artifacts?: Record<string, { sha256?: string; bytes?: number }> };
  if (manifest.status !== "passed" || manifest.comparison?.id !== comparisonId || manifest.comparison.revision !== against || manifest.source?.revision !== against || !/^[0-9a-f]{40}$/i.test(manifest.source?.tree ?? "") || manifest.source.clean !== true || !manifest.source.root || await fs.promises.realpath(manifest.source.root) === currentRoot) throw new Error("Comparison manifest does not prove a passed clean capture from a distinct source root at the exact --against revision");
  const artifacts: ComparisonSnapshot["artifacts"] = {};
  for (const name of ["journey.mp4", "journey.gif"]) {
    const record = manifest.artifacts?.[name];
    if (!record?.sha256 || !record.bytes) throw new Error(`Comparison manifest is missing verified ${name}`);
    const artifact = path.join(path.dirname(canonicalFile), name);
    if ((await sha256(artifact)) !== record.sha256 || (await fs.promises.stat(artifact)).size !== record.bytes) throw new Error(`Comparison artifact hash mismatch: ${artifact}`);
    artifacts[name] = { sha256: record.sha256, bytes: record.bytes };
  }
  const snapshot = { path: canonicalFile, sha256: createHash("sha256").update(bytes).digest("hex"), source: { root: manifest.source.root, revision: against, tree: manifest.source.tree ?? "" }, artifacts };
  await verifyComparisonUnchanged(snapshot);
  return snapshot;
}
export async function capture(options: Options): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(options.revision) || !/^[0-9a-f]{40}$/i.test(options.against)) throw new Error("--revision and --against must be full 40-character commit SHAs");
  if (options.revision === options.against) throw new Error("Before/after source revisions must be distinct");
  validatePorts(options.ports);
  const source = await fs.promises.realpath(options.source);
  const head = await validateSource(source, options.revision);
  const initialTree = await runFile("git", ["rev-parse", "HEAD^{tree}"], source);
  const againstCommit = await runFile("git", ["rev-parse", "--verify", `${options.against}^{commit}`], source);
  if (againstCommit !== options.against) throw new Error(`Comparison revision must resolve to the exact commit: ${options.against}`);
  const comparisonId = [head, againstCommit].sort().join("-");
  const comparisonSnapshot = options.comparisonManifest ? await validateComparisonManifest(options.comparisonManifest, againstCommit, comparisonId, source) : undefined;
  if (fs.existsSync(options.output)) throw new Error(`Output already exists; refusing to overwrite evidence: ${options.output}`);
  await fs.promises.mkdir(options.output, { recursive: false });
  const startedAt = new Date().toISOString();
  const logs = { server: path.join(options.output, "server.log"), runner: path.join(options.output, "runner.log") };
  const dataDir = path.join(options.output, ".runner-data");
  const artifacts: Record<string, { sha256: string; bytes: number }> = {};
  const children: ChildProcess[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let journey: EvidenceJourney | undefined;
  let primaryError: unknown;
  let cleanupErrors: unknown[] = [];
  let status: "passed" | "failed" = "failed";
  let failure = "Capture did not complete";
  let preserveData = false;
  let recordedDuration: number | null = null;
  let journeyIdentity: { path: string; sha256: string; bytes: number } | null = null;
  let logOut: number | undefined, logErr: number | undefined;
  try {
    logOut = fs.openSync(logs.server, "wx");
    logErr = fs.openSync(logs.server, "a");
    // Preflight all external executables/browser before starting the useful recording.
    await preflightExecutables(source);
    browser = await chromium.launch({ headless: true });
    const runtime: EvidenceRuntime = { ports: options.ports, urls: runtimeUrls(options.ports) };
    const canonicalJourney = await fs.promises.realpath(options.journey);
    const journeyStat = await fs.promises.stat(canonicalJourney);
    journeyIdentity = { path: canonicalJourney, sha256: await sha256(canonicalJourney), bytes: journeyStat.size };
    // SAFETY: imported journey code is explicitly supplied by the operator and its initial digest is recorded and rechecked.
    const journeyModule = await import(pathToFileURL(canonicalJourney).href) as { default?: EvidenceJourney };
    journey = journeyModule.default;
    if (!journey || !Array.isArray(journey.servers) || !journey.journey) throw new Error("Journey must export API and web servers plus journey(page, evidence, runtime)");
    validateServerContract(journey.servers, options.ports);
    for (const port of Object.values(options.ports)) await assertPortFree(port);
    await fs.promises.mkdir(dataDir, { recursive: false });
    for (const server of journey.servers) {
      const port = server.name === "api" ? options.ports.api : options.ports.web;
      const readinessUrl = validateReadinessUrl(server.readinessUrl, port);
      const cwd = await resolveServerCwd(source, server.cwd);
      const env = runnerEnvironment(options.ports, dataDir, process.env, server.env);
      const child = spawnOwnedServer(server.command, server.args, { cwd, env, stdio: ["ignore", logOut, logErr] });
      children.push(child);
      await waitReady(readinessUrl, child);
    }
    await validateSource(source, head);
    const setupContext = await browser.newContext({ viewport: VIEWPORT });
    const setupPage = await setupContext.newPage();
    if (journey.setup) await journey.setup(setupPage, runtime);
    const storageState = await setupContext.storageState();
    await setupContext.close();
    const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: options.output, size: VIEWPORT }, storageState });
    const page = await context.newPage();
    const screenshots: string[] = [];
    await journey.journey(page, { screenshotElement: async (name, selector) => {
      const file = path.join(options.output, `${artifactName(name)}.png`);
      if (fs.existsSync(file)) throw new Error(`Screenshot already exists: ${file}`);
      await page.locator(selector).screenshot({ path: file }); screenshots.push(file); return file;
    } }, runtime);
    const video = page.video();
    await context.close();
    await validateSource(source, head);
    if (!video) throw new Error("Playwright did not create a video recording");
    const webm = await video.path();
    const { mp4, gif, duration } = await convertAndValidateMedia(webm, options.output, source);
    recordedDuration = duration;
    await fs.promises.rm(webm, { force: true });
    for (const file of [mp4, gif, ...screenshots]) artifacts[path.basename(file)] = { sha256: await sha256(file), bytes: (await fs.promises.stat(file)).size };
    status = "passed"; failure = "";
  } catch (error) { primaryError = error; failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  {
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await stopServersAndCleanData(children, dataDir); } catch (error) { cleanupErrors.push(error); preserveData = true; }
    if (cleanupErrors.length) { status = "failed"; failure += `\nCleanup failed: ${cleanupErrors.map(String).join("; ")}`; }
    try {
      const final = await verifySourceSnapshot(source, head, initialTree).catch((error) => { status = "failed"; failure += `\n${String(error)}`; return { head: "unavailable", tree: "unavailable", clean: "unavailable" }; });
      const finalTree = final.tree, finalClean = final.clean;
      if (journeyIdentity) {
        try { if (await sha256(journeyIdentity.path) !== journeyIdentity.sha256) throw new Error("Journey module changed during capture"); }
        catch (error) { status = "failed"; failure += `\n${String(error)}`; }
      }
      if (comparisonSnapshot && status === "passed") {
        try { await verifyComparisonUnchanged(comparisonSnapshot); }
        catch (error) { status = "failed"; failure += `\n${String(error)}`; }
      }
      await fs.promises.writeFile(logs.runner, `${failure || "Capture passed"}\n`, { flag: "wx" });
      for (const entry of await fs.promises.readdir(options.output, { withFileTypes: true })) {
        if (!entry.isFile() || !/[.](png|webm|mp4|gif|log)$/i.test(entry.name)) continue;
        const file = path.join(options.output, entry.name), stat = await fs.promises.stat(file);
        artifacts[entry.name] = { sha256: await sha256(file), bytes: stat.size };
      }
      const manifest = { status, comparison: { id: comparisonId, revision: head, against: againstCommit, status: options.comparisonManifest ? "pair-member" : "single-capture", pairedManifest: options.comparisonManifest ?? null },  source: { root: source, revision: head, tree: finalTree, clean: finalClean === "" }, journey: journeyIdentity, command: { invocation: process.argv, journey: options.journey, servers: journey?.servers ?? null, ports: options.ports }, startedAt, finishedAt: new Date().toISOString(), viewport: VIEWPORT, durationSeconds: recordedDuration, isolatedData: { path: dataDir, removed: !preserveData && !fs.existsSync(dataDir), preservedAfterCleanupFailure: preserveData }, artifacts, logs, failure };
      const manifestPath = path.join(options.output, "manifest.json");
      await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      if (comparisonSnapshot && status === "passed") {
        // Use only the snapshot whose manifest and media digests were checked again during finalization.
        await fs.promises.writeFile(path.join(options.output, "comparison-pair.json"), `${JSON.stringify({ status: "pair-verified", id: comparisonId, before: { manifest: comparisonSnapshot.path, sha256: comparisonSnapshot.sha256, ...comparisonSnapshot.source }, after: { manifest: manifestPath, sha256: await sha256(manifestPath), root: source, revision: head, tree: finalTree } }, null, 2)}\n`, { flag: "wx" });
      }
    } catch (manifestError) { failure += `\nManifest write failed: ${String(manifestError)}`; status = "failed"; }
    if (logOut !== undefined) fs.closeSync(logOut);
    if (logErr !== undefined) fs.closeSync(logErr);
  }
  if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "Capture failed and cleanup also failed");
  if (primaryError) throw primaryError;
  if (status !== "passed") throw new Error(failure || "Capture failed");
}
if (import.meta.main) { try { await capture(parseArgs(process.argv.slice(2))); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
