// Probe: does writing a file inside a directory refresh the directory's mtime?
// The reclaim's grace is measured from the lock directory's mtime, so the
// answer decides whether a pid-less lock can be reclaimed while its holder is
// alive.
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const dir = mkdtempSync(join(tmpdir(), "mtime-probe-"));
const lock = join(dir, "wt.lock");
mkdirSync(lock);
const afterMkdir = statSync(lock).mtimeMs;
// The filesystem stamps file times with a coarse clock, so the two calls have
// to be far enough apart for the second stamp to be a different one.
sleepSync(120);
writeFileSync(join(lock, "pid"), "1 token\n");
const afterPid = statSync(lock).mtimeMs;
console.log("dir mtime after mkdir:", afterMkdir);
console.log("dir mtime after the pid file was written:", afterPid);
console.log("the pid write refreshed the directory's mtime:", afterPid > afterMkdir);
