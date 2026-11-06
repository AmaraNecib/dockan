import { expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { assertPortFree, capture } from "./capture-browser-evidence";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!(address instanceof Object)) throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function until(check: () => boolean, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

// OS signal delivery is POSIX-specific; portable cases execute the same registered handlers
// in an isolated child without letting Windows terminate it before cleanup can run.
for (const delivery of ["portable", "os"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const stage of ["launch", "late-close-failure", "readiness", "setup", "journey", "video-path"] as const) {
      const test = delivery === "os" && process.platform === "win32" ? it.skip : it;
      test(`cancels ${stage} with ${signal} (${delivery}) and certifies only failed cleanup`, async () => {
        expect(capture).toBeFunction();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-cancel-"));
        const source = path.join(root, "source"); fs.mkdirSync(source);
        const marker = path.join(root, "ready"), closed = path.join(root, "closed"), pidFile = path.join(root, "server-pid");
        const output = path.join(root, "output");
        const ports = { api: await freePort(), web: await freePort(), vault: await freePort(), vaultWeb: await freePort() };
        const serverCode = `import fs from 'node:fs'; const port=Number(process.argv[2]); const s=Bun.serve({hostname:'127.0.0.1',port,fetch(){return new Response('fixture',{status:${stage === "readiness" ? "503" : "200"}})}}); fs.writeFileSync(${JSON.stringify(pidFile)}+'-'+process.argv[3],String(process.pid)); if(process.argv[3]==='api'){${stage === "readiness" ? `fs.writeFileSync(${JSON.stringify(marker)},'ready');` : ""}}`;
        fs.writeFileSync(path.join(source, "server.mjs"), serverCode);
        git(source, "init", "-q"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
        git(source, "add", "."); git(source, "commit", "-qm", "before"); const against = git(source, "rev-parse", "HEAD");
        fs.writeFileSync(path.join(source, "second.txt"), "after"); git(source, "add", "."); git(source, "commit", "-qm", "after");
        const revision = git(source, "rev-parse", "HEAD");
        const journey = path.join(root, "journey.mjs");
        const pending = `async()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready'); await new Promise(()=>{});}`;
        fs.writeFileSync(journey, `import fs from 'node:fs'; export default { servers:${JSON.stringify(["api", "web"].map((name) => ({ name, command: process.execPath, args: ["server.mjs", String(name === "api" ? ports.api : ports.web), name], cwd: ".", readinessUrl: `http://127.0.0.1:${name === "api" ? ports.api : ports.web}/` })))}, setup:${stage === "setup" ? pending : "async()=>{}"}, journey:${stage === "journey" ? pending : stage === "video-path" ? "async()=>{}" : "async()=>{throw new Error('unexpected journey')}"} };`);
        const fixture = path.join(root, "runner.mjs");
        const runner = pathToFileURL(path.resolve(import.meta.dir, "capture-browser-evidence.ts")).href;
        fs.writeFileSync(fixture, `import fs from 'node:fs'; import {capture} from ${JSON.stringify(runner)};
const baseline=['SIGINT','SIGTERM'].map(s=>process.listenerCount(s));
process.stdin.on('data',()=>{process.emit(${JSON.stringify(signal)});process.emit(${JSON.stringify(signal)});});
const context={newPage:async()=>({video:()=>({path:async()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(r=>setTimeout(r,120));return 'cancelled.webm';}})}),storageState:async()=>({cookies:[],origins:[]}),close:async()=>{}};
const browser={newContext:async()=>context,close:async()=>{await new Promise(r=>setTimeout(r,80));fs.writeFileSync(${JSON.stringify(closed)},'closed');${stage === "late-close-failure" ? "throw new Error('injected late disposal failed');" : ""}}};
try { await capture(${JSON.stringify({ journey, source, revision, against, output, ports })},{preflight:async()=>{},launch:async()=>{${stage === "launch" || stage === "late-close-failure" ? `fs.writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(r=>setTimeout(r,120));` : ""}return browser;}}); console.log('UNEXPECTED SUCCESS');process.exitCode=2; }
catch(error){await new Promise(r=>setTimeout(r,200)); console.log(JSON.stringify({failure:error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error),listeners:['SIGINT','SIGTERM'].map(s=>process.listenerCount(s)),baseline}));}
process.stdin.destroy();`);
        const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
        let transcript = ""; child.stdout?.on("data", (data) => { transcript += String(data); }); child.stderr?.on("data", (data) => { transcript += String(data); });
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        try {
          expect(await until(() => fs.existsSync(marker), child)).toBe(true);
          if (delivery === "os") child.kill(signal); else child.stdin?.write("cancel\n");
          await Promise.race([exited, Bun.sleep(10_000).then(() => { throw new Error(`Cancellation timeout: ${transcript}`); })]);
          expect(child.exitCode).toBe(0);
          expect(transcript).not.toContain("UNEXPECTED SUCCESS");
          const result = JSON.parse(transcript.trim());
          expect(result.failure).toContain(`cancelled by ${signal}`);
          expect(result.listeners).toEqual(result.baseline);
          expect(fs.readFileSync(closed, "utf8")).toBe("closed");
          const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
          expect(manifest.status).toBe("failed");
          expect(manifest.failure).toContain(signal);
          if (stage === "late-close-failure") expect(manifest.failure).toContain("injected late disposal failed");
          expect(manifest.isolatedData.removed).toBe(true);
          expect(fs.existsSync(path.join(output, "comparison-pair.json"))).toBe(false);
          const log = fs.readFileSync(path.join(output, "runner.log"));
          expect(manifest.artifacts["runner.log"]).toEqual({ sha256: createHash("sha256").update(log).digest("hex"), bytes: log.length });
          for (const port of Object.values(ports)) await assertPortFree(port);
          for (const name of ["api", "web"]) {
            const file = `${pidFile}-${name}`;
            if (fs.existsSync(file)) expect(() => process.kill(Number(fs.readFileSync(file, "utf8")), 0)).toThrow();
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
          // Only the PID written by this fixture is eligible for emergency teardown.
          for (const name of ["api", "web"]) {
            const file = `${pidFile}-${name}`;
            if (fs.existsSync(file)) { try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already stopped */ } }
          }
          fs.rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
}
