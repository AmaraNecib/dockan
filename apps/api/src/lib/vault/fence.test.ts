import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_SNAPSHOT_STAMP_BYTES,
  SNAPSHOT_FENCE_PREFIX_BYTES,
  VAULT_SNAPSHOT_LEGACY_VERSION,
  VAULT_SNAPSHOT_MAGIC,
  VAULT_SNAPSHOT_VERSION,
} from "./format";
import { type FenceVerdict, type HolderStamp, fromEnvelope, fromPath } from "./fence";

/**
 * The one reader for "whose bytes are these" (#307). The table below is the
 * whole vocabulary on purpose: after this change the open path, the pre-write
 * check and the backup check consume these verdicts instead of comparing stamps
 * themselves, so a state the table does not name is a state the connection
 * would re-derive — which is exactly what #307 removes.
 */

const holderA = "a".repeat(32);
const holderB = "b".repeat(32);

/** A legacy (v1) envelope: `magic ‖ 1 ‖ body`. */
function legacy(bodyBytes = 40): Buffer {
  return Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_LEGACY_VERSION]), Buffer.alloc(bodyBytes, 9)]);
}

/** A fenced (v2) envelope: `magic ‖ 2 ‖ len ‖ stamp ‖ body`. */
function stamped(stamp: string, bodyBytes = 40): Buffer {
  const stampBytes = Buffer.from(stamp, "utf8");
  return Buffer.concat([
    VAULT_SNAPSHOT_MAGIC,
    Buffer.from([VAULT_SNAPSHOT_VERSION]),
    Buffer.from([stampBytes.length]),
    stampBytes,
    Buffer.alloc(bodyBytes, 9),
  ]);
}

describe("fenceOfEnvelope: the byte table (#307)", () => {
  const cases: Array<{ name: string; bytes: Buffer; holder: HolderStamp; expected: FenceVerdict }> = [
    { name: "magic|1, a holder that writes legacy bytes", bytes: legacy(), holder: undefined, expected: { outcome: "mine" } },
    { name: "magic|1, a holder that writes stamped bytes", bytes: legacy(), holder: holderA, expected: { outcome: "unstamped" } },
    { name: "magic|1 and nothing after the version byte", bytes: legacy().subarray(0, VAULT_SNAPSHOT_MAGIC.length + 1), holder: holderA, expected: { outcome: "unstamped" } },
    { name: "magic|2|stamp, the holder's own stamp", bytes: stamped(holderA), holder: holderA, expected: { outcome: "mine" } },
    { name: "magic|2|stamp, another holder's stamp", bytes: stamped(holderB), holder: holderA, expected: { outcome: "foreign", stamp: holderB } },
    // The disagreement #307 removes: an unfenced holder asking about fenced
    // bytes. It has no stamp, so no comparison exists; "foreign" was what one
    // of the three implementations answered, "mine" what another did.
    { name: "magic|2|stamp, a holder with no stamp", bytes: stamped(holderB), holder: undefined, expected: { outcome: "unfenced-holder" } },
    { name: "a stamp of exactly the 64-byte bound", bytes: stamped("y".repeat(MAX_SNAPSHOT_STAMP_BYTES)), holder: "y".repeat(MAX_SNAPSHOT_STAMP_BYTES), expected: { outcome: "mine" } },
    { name: "empty", bytes: Buffer.alloc(0), holder: holderA, expected: { outcome: "undecidable" } },
    { name: "wrong magic", bytes: Buffer.concat([Buffer.alloc(VAULT_SNAPSHOT_MAGIC.length, 0), Buffer.from([VAULT_SNAPSHOT_VERSION, 4])]), holder: holderA, expected: { outcome: "undecidable" } },
    { name: "an unknown version", bytes: Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([99]), Buffer.alloc(64, 3)]), holder: holderA, expected: { outcome: "undecidable" } },
    { name: "truncated inside the stamp", bytes: stamped(holderA).subarray(0, VAULT_SNAPSHOT_MAGIC.length + 2 + 3), holder: holderA, expected: { outcome: "undecidable" } },
    { name: "a stamp length byte of zero", bytes: Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION, 0]), Buffer.alloc(8, 9)]), holder: holderA, expected: { outcome: "undecidable" } },
    { name: "a stamp longer than the 64-byte bound", bytes: Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION, MAX_SNAPSHOT_STAMP_BYTES + 1]), Buffer.alloc(MAX_SNAPSHOT_STAMP_BYTES + 1, 9)]), holder: holderA, expected: { outcome: "undecidable" } },
  ];

  for (const testCase of cases) {
    it(`reads ${testCase.name}`, () => {
      expect(fromEnvelope(testCase.bytes, testCase.holder)).toEqual(testCase.expected);
    });
  }

  it("never answers foreign to a holder with no stamp: no comparison exists to make", () => {
    // The failing half of #307 stated on its own, because the table above can
    // pass by accident while this rule is what the connection depends on: a
    // holder that writes legacy bytes must never be told that stamped bytes are
    // "another holder's", which refuses writes and backups over a state it
    // cannot read.
    for (const bytes of [stamped(holderA), stamped(holderB), stamped("y".repeat(MAX_SNAPSHOT_STAMP_BYTES)), legacy()]) {
      expect(fromEnvelope(bytes, undefined)).not.toEqual({ outcome: "foreign", stamp: holderA });
      expect(fromEnvelope(bytes, undefined).outcome).not.toBe("foreign");
    }
  });
});

describe("fenceOfPath: the file entry point (#307)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-fence-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const snapshotPath = (): string => path.join(dir, "dokan.db.enc");

  it("reads a stamped snapshot as the file it is", () => {
    fs.writeFileSync(snapshotPath(), stamped(holderA));
    expect(fromPath(snapshotPath(), holderA)).toEqual({ outcome: "mine" });
    expect(fromPath(snapshotPath(), holderB)).toEqual({ outcome: "foreign", stamp: holderA });
    expect(fromPath(snapshotPath(), undefined)).toEqual({ outcome: "unfenced-holder" });
  });

  it("answers absent when there is no file at the path", () => {
    expect(fromPath(snapshotPath(), holderA)).toEqual({ outcome: "absent" });
  });

  it("answers absent for a path that is a directory, which is decidable, not an I/O failure", () => {
    // a snapshot path that is gone and one that an outside actor made a
    // directory answer the same question: there is no file here. Calling this
    // "unreadable" sent the post-write branch down its benign exit over a
    // snapshot that was gone.
    fs.mkdirSync(snapshotPath());
    expect(fromPath(snapshotPath(), holderA)).toEqual({ outcome: "absent" });
  });

  it("answers unreadable for a transient refusal, and that is not a verdict about the bytes", () => {
    fs.writeFileSync(snapshotPath(), stamped(holderA));
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload the reader calls, which is the
    // whole of what that call passes
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload the reader calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    try {
      expect(fromPath(snapshotPath(), holderA)).toEqual({ outcome: "unreadable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a bounded fence prefix, not the whole snapshot", () => {
    // The fence read exists so a check before every write stays cheap. The
    // bound lives here now, with the only code that opens the path: without a
    // pin on the read length, slurping the whole multi-megabyte snapshot would
    // pass every other test in the repository.
    fs.writeFileSync(snapshotPath(), stamped(holderA, 4 * 1024 * 1024));
    const realReadSync = fs.readSync.bind(fs);
    let widest = 0;
    // SAFETY: the reader calls readSync with (fd, buffer, offset, length,
    // position) and forwards the result unchanged, so the narrowed signature
    // describes the one overload that is spied on
    const spy = spyOn(fs, "readSync").mockImplementation(
      ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
        widest = Math.max(widest, length);
        return realReadSync(fd, buffer, offset, length, position);
      }) as typeof fs.readSync,
    );
    try {
      expect(fromPath(snapshotPath(), holderA)).toEqual({ outcome: "mine" });
    } finally {
      spy.mockRestore();
    }
    expect(widest).toBe(SNAPSHOT_FENCE_PREFIX_BYTES);
    expect(widest).toBeLessThan(200);
  });
});
