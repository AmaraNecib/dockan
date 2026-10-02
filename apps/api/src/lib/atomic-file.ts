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

export function writeFileAtomicSync(filePath: string, data: Uint8Array | string): void {
  const partial = partialPathFor(filePath);
  const fd = fs.openSync(partial, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(partial, filePath);
  } catch (error) {
    cleanupPartial(partial);
    throw error;
  }
}

export async function writeFileAtomic(filePath: string, data: Uint8Array | string): Promise<void> {
  const partial = partialPathFor(filePath);
  const handle = await fs.promises.open(partial, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(partial, filePath);
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
