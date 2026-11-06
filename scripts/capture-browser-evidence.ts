import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { stopOwnedServer, spawnOwnedServer } from "../tests/e2e/owned-server-process";

export type EvidenceJourney = {
  server: { command: string; args: string[]; cwd: string; readinessUrl: string; env?: Record<string, string> };
  journey(page: Page, evidence: { screenshotElement(name: string, selector: string): Promise<string> }): Promise<void>;
};
type Options = { journey: string; source: string; revision: string; against: string; output: string; port: number };
const VIEWPORT = { width: 1920, height: 1080 };
const MIN_SECONDS = 30;
const MAX_SECONDS = 45;

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new Error(`Expected unique --name value arguments; invalid argument: ${key ?? "<missing>"}`);
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing required ${key}`);
    return value;
  };
  const port = Number(values.get("--port") ?? "0");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an explicit TCP port from 1 to 65535");
  return { journey: path.resolve(required("--journey")), source: path.resolve(required("--source")), revision: required("--revision"), against: required("--against"), output: path.resolve(required("--output")), port };
}
function runFile(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr.trim()}`)));
  });
}
async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
}
export async function validateSource(source: string, revision: string): Promise<string> {
  const canonicalSource = await fs.promises.realpath(source);
  const head = await runFile("git", ["rev-parse", "HEAD"], canonicalSource);
  if (head !== revision) throw new Error(`Source revision mismatch: expected ${revision}, found ${head}`);
  const dirty = await runFile("git", ["status", "--porcelain"], canonicalSource);
  if (dirty) throw new Error(`Source tree is dirty; refusing evidence capture:\n${dirty}`);
  return head;
}
export async function assertPortFree(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TCP port: ${port}`);
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is occupied; runner will not reuse a listener`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}
export function validateReadinessUrl(value: string, port: number): string {
  let url: URL;
  try { url = new URL(value.replaceAll("{port}", String(port))); }
  catch { throw new Error(`Invalid readiness URL: ${value}`); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port) !== port) {
    throw new Error(`Readiness URL must use loopback and the allocated port ${port}: ${url.href}`);
  }
  return url.href;
}
export async function waitReady(url: string, child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned server exited before readiness (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server readiness timed out at ${url}: ${lastError}`);
}
function artifactName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) throw new Error(`Invalid screenshot name: ${name}`);
  return name;
}
export async function capture(options: Options): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(options.revision) || !/^[0-9a-f]{40}$/i.test(options.against)) throw new Error("--revision and --against must be full 40-character commit SHAs");
  if (options.revision === options.against) throw new Error("Before/after source revisions must be distinct");
  const source = await fs.promises.realpath(options.source);
  const head = await validateSource(source, options.revision);
  const initialTree = await runFile("git", ["rev-parse", "HEAD^{tree}"], source);
  const againstCommit = await runFile("git", ["rev-parse", "--verify", `${options.against}^{commit}`], source);
  if (againstCommit !== options.against) throw new Error(`Comparison revision must resolve to the exact commit: ${options.against}`);
  if (fs.existsSync(options.output)) throw new Error(`Output already exists; refusing to overwrite evidence: ${options.output}`);
  await fs.promises.mkdir(options.output, { recursive: false });
  let journey: EvidenceJourney | undefined;
  const logs = { server: path.join(options.output, "server.log"), runner: path.join(options.output, "runner.log") };
  let child: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let outcome: "passed" | "failed" = "failed";
  let failure = "Capture did not complete";
  const artifacts: Record<string, { sha256: string; bytes: number }> = {};
  const start = new Date().toISOString();
  let primaryError: unknown;
  let cleanupFailure: unknown[] = [];
  let serverOut: number | undefined;
  let serverErr: number | undefined;
  try {
    await assertPortFree(options.port);
    // SAFETY: journey modules are repository-authored code and must implement the documented contract.
    const journeyModule = await import(pathToFileURL(options.journey).href) as { default?: EvidenceJourney };
    journey = journeyModule.default;
    if (!journey || journey.journey === undefined || !journey.server?.command || !Array.isArray(journey.server.args)) throw new Error("Journey module must default-export { server: { command, args, cwd, readinessUrl }, journey(page, evidence) }");
    const readinessUrl = validateReadinessUrl(journey.server.readinessUrl, options.port);
    const serverCwd = await fs.promises.realpath(path.resolve(source, journey.server.cwd));
    if (!serverCwd.startsWith(`${source}${path.sep}`) && serverCwd !== source) throw new Error("Server cwd must stay inside the pinned source root");
    serverOut = fs.openSync(logs.server, "w");
    serverErr = fs.openSync(logs.server, "a");
    child = spawnOwnedServer(journey.server.command, journey.server.args, { cwd: serverCwd, env: { ...process.env, ...journey.server.env, PORT: String(options.port) }, stdio: ["ignore", serverOut, serverErr] });
    await waitReady(readinessUrl, child);
    await validateSource(source, options.revision);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: options.output, size: VIEWPORT } });
    const page = await context.newPage();
    const screenshots: string[] = [];
    await validateSource(source, options.revision);
    await journey.journey(page, { screenshotElement: async (name, selector) => {
      const file = path.join(options.output, `${artifactName(name)}.png`);
      if (fs.existsSync(file)) throw new Error(`Screenshot already exists: ${file}`);
      await page.locator(selector).screenshot({ path: file });
      screenshots.push(file);
      return file;
    } });
    const video = page.video();
    await context.close();
    await validateSource(source, options.revision);
    if (video) {
      const webm = await video.path();
      await runFile("ffmpeg", ["-version"], source);
      await runFile("ffprobe", ["-version"], source);
      const durationText = await runFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", webm], source);
      const duration = Number(durationText);
      if (!Number.isFinite(duration) || duration < MIN_SECONDS || duration > MAX_SECONDS) throw new Error(`Recorded journey duration ${durationText}s is outside ${MIN_SECONDS}-${MAX_SECONDS}s; add real visible actions or reading pauses, do not pad or change speed`);
      const mp4 = path.join(options.output, "journey.mp4");
      const gif = path.join(options.output, "journey.gif");
      await runFile("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mp4], options.source);
      await runFile("ffmpeg", ["-y", "-i", webm, "-filter_complex", "[0:v] fps=15,scale=960:-1:flags=lanczos,split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer", gif], options.source);
      const mp4Duration = Number(await runFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4], options.source));
      const mp4Info = await runFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", mp4], source);
      const gifInfo = await runFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", gif], source);
      if (!Number.isFinite(mp4Duration) || mp4Duration < MIN_SECONDS || mp4Duration > MAX_SECONDS || mp4Info !== "video,1920,1080" || gifInfo !== "video,960,540") throw new Error(`Converted evidence validation failed: duration=${mp4Duration}s, mp4=${mp4Info}, gif=${gifInfo}`);
      for (const file of [mp4, gif, ...screenshots]) artifacts[path.basename(file)] = { sha256: await sha256(file), bytes: (await fs.promises.stat(file)).size };
      await fs.promises.rm(webm, { force: true });
    }
    if (!artifacts["journey.mp4"]) throw new Error("Playwright did not finalize a recording");
    outcome = "passed";
    failure = "";
  } catch (error) {
    primaryError = error;
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    outcome = "failed";
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    if (child) try { await stopOwnedServer(child); } catch (error) { cleanupErrors.push(error); }
    cleanupFailure = cleanupErrors;
    if (cleanupErrors.length) {
      failure += `\nCleanup failed: ${cleanupErrors.map(String).join("; ")}`;
      outcome = "failed";
    }
    try {
      await fs.promises.writeFile(logs.runner, `${failure || "Capture passed"}\n`, { flag: "wx" });
      for (const file of [logs.server, logs.runner]) if (fs.existsSync(file)) artifacts[path.basename(file)] = { sha256: await sha256(file), bytes: (await fs.promises.stat(file)).size };
      const finalHead = await runFile("git", ["rev-parse", "HEAD"], source).catch(() => "unavailable");
      const finalTree = await runFile("git", ["rev-parse", "HEAD^{tree}"], source).catch(() => "unavailable");
      const finalClean = await runFile("git", ["status", "--porcelain"], source).catch(() => "unavailable");
      if (finalHead !== head || finalTree !== initialTree || finalClean !== "") { outcome = "failed"; failure += "\nSource identity or cleanliness changed during capture"; }
      const manifest = { status: outcome, comparison: { id: [head, againstCommit].sort().join("-"), revision: head, against: againstCommit }, source: { root: source, revision: head, tree: finalTree, clean: finalClean === "" }, command: { invocation: process.argv, journey: options.journey, server: journey?.server ?? null, port: options.port }, startedAt: start, finishedAt: new Date().toISOString(), viewport: VIEWPORT, durationSeconds: null, artifacts, logs, failure };
      await fs.promises.writeFile(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    } catch (manifestError) {
      failure += `\nManifest write failed: ${String(manifestError)}`;
      outcome = "failed";
    } finally {
      if (serverOut !== undefined) fs.closeSync(serverOut);
      if (serverErr !== undefined) fs.closeSync(serverErr);
    }
  }
  if (primaryError) throw cleanupFailure ? new AggregateError([primaryError, ...cleanupFailure], "Capture failed and cleanup also failed") : primaryError;
  if (outcome !== "passed") throw new Error(failure || "Capture failed");
}
if (import.meta.main) {
  try { await capture(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
