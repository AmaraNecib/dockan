import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Crash-safe file replacement: write a uniquely-named sibling, fsync it, then
 * rename over the destination. A crash leaves either the old complete file or
 * the new complete file — never a truncated one. The unique suffix keeps
 * overlapping writers (two boots) from racing on one temp name.
 */

function partialPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
}

function cleanupPartial(partial: string): void {
  try {
    fs.unlinkSync(partial);
  } catch {
    /* the partial is already gone */
  }
}

/**
 * fsync the directory entry after a rename where the platform supports it, so
 * the rename itself is durable across power loss (the file's own fsync does
 * not cover the directory entry). Best-effort: Windows refuses to open a
 * directory as a file, and the rename is atomic there regardless.
 */
function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    /* directory fsync unsupported on this platform */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Remove leftover `.name.tmp-*` siblings from a crashed writer. Only files
 * matching this module's exact temp prefix are touched; a live writer's
 * partial (its pid/random suffix) could in principle be cleaned by a second
 * process, but the vault is single-writer (issue #142).
 */
export function cleanupStalePartials(directory: string, baseName: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  const prefix = `.${baseName}.tmp-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(path.join(directory, entry));
    } catch {
      /* another process/race already removed it */
    }
  }
}

/**
 * Where the caller gets its last word before the rename.
 *
 * `beforeRename` runs after the temp file is written and fsynced and
 * immediately before it is renamed over the destination. A throw aborts the
 * rename, removes the temp file and propagates unchanged, so the caller sees
 * its own refusal instead of a wrapped write error. The hook exists because
 * the gap between "I checked" and "the rename happened" is the whole point: a
 * check made before a multi-megabyte write leaves that write's duration as the
 * window a takeover can land in (ADR-0012 clause 3, #280).
 */
export type AtomicWriteOptions = {
  beforeRename?: () => void;
};

export function writeFileAtomicSync(filePath: string, data: Uint8Array | string, options: AtomicWriteOptions = {}): void {
  const partial = partialPathFor(filePath);
  const fd = fs.openSync(partial, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    options.beforeRename?.();
    fs.renameSync(partial, filePath);
    fsyncDirectoryBestEffort(path.dirname(filePath));
  } catch (error) {
    cleanupPartial(partial);
    throw error;
  }
}

export async function writeFileAtomic(filePath: string, data: Uint8Array | string, options: AtomicWriteOptions = {}): Promise<void> {
  const partial = partialPathFor(filePath);
  const handle = await fs.promises.open(partial, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    options.beforeRename?.();
    await fs.promises.rename(partial, filePath);
    fsyncDirectoryBestEffort(path.dirname(filePath));
  } catch (error) {
    cleanupPartial(partial);
    throw error;
  }
}

/** Read a UTF-8 file, or undefined when it does not exist. */
export function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // SAFETY: the `"code" in error` probe is exactly the NodeJS errno shape;
    // the cast only exposes the code this branch inspects
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
