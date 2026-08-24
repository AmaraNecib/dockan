import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  forgetPort,
  portIsReachable,
  probeHostFor,
  publishPort,
  readRegistryEntry,
  recomputeCanonical,
  withPortFileLock,
  writeRegistryEntry,
} from "./port-record";

/** a port that is definitely not listening */
const DEAD_PORT = 49999;
let dir: string;
let lockDir: string;
let registryDir: string;
let portFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-record-"));
  lockDir = path.join(dir, ".dokan-port.lock");
  registryDir = path.join(dir, ".dokan-port.registry");
  portFile = path.join(dir, ".dokan-port");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("withPortFileLock", () => {
  it("serializes concurrent critical sections (mutual exclusion)", async () => {
    let inside = 0;
    let maxOverlap = 0;
    const work = async (): Promise<void> => {
      await withPortFileLock(lockDir, async () => {
        inside++;
        maxOverlap = Math.max(maxOverlap, inside);
        await Bun.sleep(30);
        inside--;
      });
    };
    await Promise.all([work(), work(), work()]);
    expect(maxOverlap).toBe(1);
  });

  it("recovers a lock whose holder pid is dead", async () => {
    const stale = path.join(dir, "stale.lock");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "pid"), String(999999), "utf8"); // nobody's pid
    const then = Date.now() - 60_000; // backdate past the grace window
    const file = path.join(stale, "pid");
    const past = new Date(then);
    fs.utimesSync(file, past, past);
    fs.utimesSync(stale, past, past);

    let ran = false;
    await withPortFileLock(stale, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // lock released cleanly
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("recovers a freshly-dead marker holder immediately (marker proves identity)", async () => {
    const fresh = path.join(dir, "fresh-dead-marker.lock");
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, "pid"), String(999999), "utf8");
    // marker present + pid dead = holder wrote it and died: recover at once,
    // even though the dir is fresh (the grace window protects marker-less dirs)
    let ran = false;
    await withPortFileLock(fresh, async () => {
      ran = true;
    }, { graceMs: 5000 });
    expect(ran).toBe(true);
  });

  it("recovers a crashed-pre-marker dir only after the grace window passes", async () => {
    const fresh = path.join(dir, "fresh-markerless-grace.lock");
    fs.mkdirSync(fresh); // no pid file: holder died before writing it
    // SAFETY: our own backdate sets a deterministic old mtime
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(fresh, past, past);
    // OLD marker-less dir = abandoned -> recovered after grace confirms it
    let ran = false;
    await withPortFileLock(fresh, async () => {
      ran = true;
    }, { graceMs: 50, deadlineMs: 2000 });
    expect(ran).toBe(true);
  });

  it("waits for a live holder instead of breaking exclusivity", async () => {
    const held = path.join(dir, "held.lock");
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, "pid"), String(process.pid), "utf8"); // live: us
    let rejected = false;
    try {
      await withPortFileLock(held, async () => undefined, { deadlineMs: 150 });
    } catch (err) {
      // SAFETY: lock timeouts surface as Error with a code-like message
      rejected = (err as Error).message.includes("lock timeout");
    }
    expect(rejected).toBe(true);
  });

  it("a displaced owner never touches the winning dir (read-back verify)", async () => {
    // Simulate the mkdir->marker displacement: another "process" creates the
    // dir and owns it; a second acquisition must not act on it and must give
    // up within its deadline while leaving the owner's dir intact.
    const showdown = path.join(dir, "showdown.lock");
    fs.mkdirSync(showdown);
    fs.writeFileSync(path.join(showdown, "pid"), String(process.pid), "utf8");
    const marker = path.join(showdown, "pid");
    let rejected = false;
    try {
      await withPortFileLock(showdown, async () => undefined, { deadlineMs: 150 });
    } catch (err) {
      // SAFETY: lock timeouts surface as Error with a code-like message
      rejected = (err as Error).message.includes("lock timeout");
    }
    expect(rejected).toBe(true);
    expect(fs.existsSync(showdown)).toBe(true);
    // SAFETY: own marker content is a bare pid
    expect(Number(fs.readFileSync(marker, "utf8").trim())).toBe(process.pid);
  });
});

describe("registry", () => {
  it("normalizes wildcard bind hosts to a probeable loopback", () => {
    expect(probeHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHostFor("::")).toBe("127.0.0.1");
    expect(probeHostFor("192.168.1.5")).toBe("192.168.1.5");
  });

  it("parses JSON entries, prunes dead pids, accepts legacy bare-int entries", () => {
    writeRegistryEntry(registryDir, process.pid, "127.0.0.1", 4317);
    // SAFETY: our own registry write shapes the entry file
    const mine = readRegistryEntry(registryDir, String(process.pid))!;
    expect(mine.port).toBe(4317);

    // dead pid entry: pruned
    fs.writeFileSync(path.join(registryDir, "999999"), JSON.stringify({ host: "127.0.0.1", port: 4318 }), "utf8");
    expect(readRegistryEntry(registryDir, "999999")).toBeNull();
    expect(fs.existsSync(path.join(registryDir, "999999"))).toBe(false);

    // legacy bare int (own pid)
    fs.writeFileSync(path.join(registryDir, String(process.pid)), "4320", "utf8");
    // SAFETY: the bare-int file is ours
    expect(readRegistryEntry(registryDir, String(process.pid))!.port).toBe(4320);
    // restore the JSON form for later tests
    writeRegistryEntry(registryDir, process.pid, "127.0.0.1", 4317);
  });

  it("propagates registry entry I/O failures instead of treating them as no entry", () => {
    const entryFile = path.join(registryDir, String(process.pid));
    fs.rmSync(entryFile, { recursive: true, force: true });
    fs.mkdirSync(entryFile); // readFileSync(directory) throws EISDIR
    expect(() => readRegistryEntry(registryDir, String(process.pid))).toThrow();
    fs.rmSync(entryFile, { recursive: true, force: true });
  });

  it("retains a live entry after transient probe failures", async () => {
    const transientDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-transient-"));
    writeRegistryEntry(transientDir, process.pid, "127.0.0.1", DEAD_PORT);
    let probes = 0;
    const canonical = await recomputeCanonical(transientDir, async () => {
      probes++;
      return false;
    });
    expect(probes).toBe(3);
    expect(canonical).toEqual({ host: "127.0.0.1", port: DEAD_PORT });
    expect(fs.existsSync(path.join(transientDir, String(process.pid)))).toBe(true);
    fs.rmSync(transientDir, { recursive: true, force: true });
  });

  it("keeps the newest live entry after all transient probes fail", async () => {
    const rollingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-rolling-"));
    const olderPort = DEAD_PORT - 1;
    const newerPort = DEAD_PORT;
    writeRegistryEntry(rollingDir, process.ppid, "127.0.0.1", olderPort);
    writeRegistryEntry(rollingDir, process.pid, "127.0.0.1", newerPort);
    const oldTime = new Date(Date.now() - 1000);
    const newTime = new Date();
    fs.utimesSync(path.join(rollingDir, String(process.ppid)), oldTime, oldTime);
    fs.utimesSync(path.join(rollingDir, String(process.pid)), newTime, newTime);

    const canonical = await recomputeCanonical(rollingDir, async () => false);
    expect(canonical).toEqual({ host: "127.0.0.1", port: newerPort });
    expect(fs.existsSync(path.join(rollingDir, String(process.pid)))).toBe(true);
    fs.rmSync(rollingDir, { recursive: true, force: true });
  });

  it("recomputeCanonical picks the newest reachable survivor and drops the rest", async () => {
    // a real listener for a "live" entry
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: the port is bound by us just above
    const livePort = (listener.address() as net.AddressInfo).port;
    writeRegistryEntry(registryDir, process.pid, "127.0.0.1", livePort);
    writeRegistryEntry(registryDir, 999998, "127.0.0.1", DEAD_PORT);

    const canonical = await recomputeCanonical(registryDir);
    expect(canonical).not.toBeNull();
    // SAFETY: recomputeCanonical returned a non-null object above
    expect((canonical as { port: number }).port).toBe(livePort);

    listener.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    // remove the still-live test PID so this case represents no survivors
    fs.unlinkSync(path.join(registryDir, String(process.pid)));
    // after the listener dies, nobody is reachable -> canonical deleted
    const after = await recomputeCanonical(registryDir, async () => false);
    expect(after).toBeNull();
  });

  it("rolls back the registry when canonical publication fails", async () => {
    const rollbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-rollback-"));
    const args = {
      portFile: path.join(rollbackDir, ".dokan-port"),
      lockDir: path.join(rollbackDir, ".dokan-port.lock"),
      registryDir: path.join(rollbackDir, ".dokan-port.registry"),
      pid: process.pid,
      host: "127.0.0.1",
      port: 4317,
    };
    let rejected = false;
    try {
      await publishPort(args, () => {
        throw new Error("simulated canonical write failure");
      });
    } catch (err) {
      // SAFETY: the injected writer throws an Error above
      rejected = (err as Error).message === "simulated canonical write failure";
    }
    expect(rejected).toBe(true);
    expect(readRegistryEntry(args.registryDir, String(process.pid))).toBeNull();
    expect(fs.existsSync(args.portFile)).toBe(false);
    fs.rmSync(rollbackDir, { recursive: true, force: true });
  });

  it("forgetPort reports lock contention instead of swallowing it", async () => {
    const contentionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-contention-"));
    const contentionLock = path.join(contentionDir, ".dokan-port.lock");
    fs.mkdirSync(contentionLock);
    fs.writeFileSync(path.join(contentionLock, "pid"), String(process.pid), "utf8");
    await expect(
      forgetPort(
        {
          portFile: path.join(contentionDir, ".dokan-port"),
          lockDir: contentionLock,
          registryDir: path.join(contentionDir, ".dokan-port.registry"),
          pid: process.pid,
        },
        { deadlineMs: 100 },
      ),
    ).rejects.toThrow("port record lock timeout");
    fs.rmSync(contentionDir, { recursive: true, force: true });
  });

  it("forgetPort reports registry filesystem failures instead of swallowing them", async () => {
    const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-port-cleanup-failure-"));
    const registryPath = path.join(failureDir, ".dokan-port.registry");
    fs.writeFileSync(registryPath, "not a directory", "utf8");
    await expect(
      forgetPort({
        portFile: path.join(failureDir, ".dokan-port"),
        lockDir: path.join(failureDir, ".dokan-port.lock"),
        registryDir: registryPath,
        pid: process.pid,
      }),
    ).rejects.toThrow();
    fs.rmSync(failureDir, { recursive: true, force: true });
  });

  it("forgetPort removes own entry and deletes the canonical when nobody survives", async () => {
    fs.writeFileSync(portFile, "4317", "utf8");
    // SAFETY: own entry exists from previous test only if written for our pid
    await forgetPort({ portFile, lockDir: path.join(dir, "fg.lock"), registryDir, pid: process.pid });
    expect(fs.existsSync(portFile)).toBe(false);
  });
});

describe("portIsReachable", () => {
  it("resolves false for a dead port without hanging", async () => {
    expect(await portIsReachable("127.0.0.1", DEAD_PORT, 80)).toBe(false);
  });
});