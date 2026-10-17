#!/usr/bin/env bun
// host-path.ts — the one place that knows a bash-style path from a node path.
//
// MSYS (the shell every crew script runs under on Windows) writes `D:` as `/d/` and
// keeps a private `/tmp`, and bash resolves both. `node:fs` does not: it reads
// `/d/projects/x` as `D:\d\projects\x` and `/tmp/x` as `D:\tmp\x`. Every path that
// comes from an env default, a `.sh` caller or a git command goes through here before
// it reaches the fs. This is the trap the ticket names -- "`/tmp` is invisible to
// native binaries" -- in code rather than in a comment.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `/d/projects/x` -> `D:/projects/x` on Windows; `/tmp/x` -> the real TEMP; else unchanged. */
export function hostPath(value: string, platform: string = process.platform): string {
  if (platform !== "win32") return value;
  const drive = /^\/([a-zA-Z])\/(.*)$/u.exec(value);
  if (drive !== null) {
    const letter = drive[1] ?? "";
    const rest = drive[2] ?? "";
    return `${letter.toUpperCase()}:/${rest}`;
  }
  if (value === "/tmp") return tmpdir();
  if (value.startsWith("/tmp/")) return join(tmpdir(), value.slice("/tmp/".length));
  return value;
}

/** A path `cmd.exe` accepts (it is not fond of forward slashes on some builtins). */
export function winPath(value: string, platform: string = process.platform): string {
  return platform === "win32" ? hostPath(value, platform).replace(/\//gu, "\\") : value;
}
