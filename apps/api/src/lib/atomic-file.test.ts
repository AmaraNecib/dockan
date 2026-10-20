import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file";

/**
 * The rename is the only moment the destination changes, so it is the only
 * moment a caller can still refuse. The hook exists because a check made
 * before a multi-megabyte write leaves that write's duration as the window a
 * takeover can land in (ADR-0012 clause 3, #280).
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-atomic-file-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = () => path.join(dir, "data.bin");

/** The temp files this module leaves behind, if any. */
function partials(): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.startsWith(".data.bin.tmp-"));
}

describe("atomic write", () => {
  it("writes the file and leaves no partial behind", async () => {
    await writeFileAtomic(target(), "first");
    expect(fs.readFileSync(target(), "utf8")).toBe("first");
    expect(partials()).toHaveLength(0);
  });

  it("a beforeRename refusal keeps the old bytes, removes the partial, and propagates the caller's own error", async () => {
    await writeFileAtomic(target(), "first");
    const refusal = new Error("the lock was lost");
    let asked = 0;

    await expect(
      writeFileAtomic(target(), "second", {
        beforeRename: () => {
          asked += 1;
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    // the refusal reached the caller unchanged: not wrapped as a write error
    expect(asked).toBe(1);
    // the destination still holds the old bytes
    expect(fs.readFileSync(target(), "utf8")).toBe("first");
    // and the temp file is gone, so the next writer does not inherit it
    expect(partials()).toHaveLength(0);
  });

  it("the synchronous path refuses the same way", () => {
    fs.writeFileSync(target(), "first");
    const refusal = new Error("the lock was lost");

    expect(() =>
      writeFileAtomicSync(target(), "second", {
        beforeRename: () => {
          throw refusal;
        },
      }),
    ).toThrow(refusal);
    expect(fs.readFileSync(target(), "utf8")).toBe("first");
    expect(partials()).toHaveLength(0);
  });
});
