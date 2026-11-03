import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Clean-room e2e start: delete the previous run's database so reruns never
// accumulate records. Called by playwright.webServer before the API boots.
//
// ISSUE #342: E2E_DATA_DIR controls a recursive delete. Lexical path checks do
// not account for a symlink or junction in the path, so containment uses the
// physical target and the physical worktree root.

function rejectSymlinkComponents(target) {
  const root = path.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`E2E_DATA_DIR refusing: "${target}" contains a symlink component (${current})`);
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
  }
}

function resolvePhysicalPath(target) {
  // The check and rmSync are separate operations. Node cannot make recursive
  // deletion atomic with this containment check, so a concurrent ancestor swap
  // remains a TOCTOU risk.
  let current = path.resolve(target);
  const unresolved = [];
  while (true) {
    try {
      const physical = fs.realpathSync.native(current);
      return path.resolve(physical, ...unresolved.reverse());
    } catch (error) {
      const code = error?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.push(path.basename(current));
      current = parent;
    }
  }
}

function resolveRootAlias(target, physicalRoot) {
  // Find the first trusted-root prefix from the filesystem root downward. A
  // deeper prefix may also resolve to physicalRoot through an inner symlink;
  // choosing it would discard that link from the suffix before validation.
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let prefix = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    prefix = path.join(prefix, parts[index]);
    try {
      if (path.resolve(fs.realpathSync.native(prefix)) === physicalRoot) {
        return path.join(physicalRoot, ...parts.slice(index + 1));
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return absolute;
      throw error;
    }
  }

  return absolute;
}

export function resolveE2eDataDir(raw, cwd) {
  if (!raw) throw new Error("E2E_DATA_DIR is required");
  const root = fs.realpathSync.native(path.resolve(cwd ?? process.cwd()));
  const target = resolveRootAlias(path.resolve(root, raw), root);
  rejectSymlinkComponents(target);
  const resolved = resolvePhysicalPath(target);
  if (resolved === root) {
    throw new Error(
      `E2E_DATA_DIR refusing: "${raw}" resolves to the working directory itself (${root}) — the e2e data dir cannot name the worktree being served`,
    );
  }
  const rel = path.relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `E2E_DATA_DIR refusing: "${raw}" (${resolved}) resolves outside the physical working directory (${root}) — wipe-e2e only deletes inside the worktree it serves; delete by hand if this target really is yours`,
    );
  }
  return resolved;
}

export function cleanE2eData(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(invokedPath)) {
  cleanE2eData(resolveE2eDataDir(process.env.E2E_DATA_DIR));
}
