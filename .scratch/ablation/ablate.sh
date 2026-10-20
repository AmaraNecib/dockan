#!/usr/bin/env bash
# Ablation runner: revert one behaviour, run one focused test file, restore.
# Usage: ablate.sh <label> <source-file> <find> <replace> <test-file> [grep-pattern]
set -u
LABEL="$1"; SRC="$2"; FIND="$3"; REPL="$4"; TEST="$5"; GREP="${6:-}"
cd /d/worktrees/mani-project/t3-291-closed-after-await/apps/api || exit 1
cp "$SRC" "$SRC.ablate.bak" || exit 1
bun -e '
const fs = require("node:fs");
const [p, findArg, replArg] = process.argv.slice(1);
let s = fs.readFileSync(p, "utf8");
let find = findArg;
let repl = replArg;
if (s.includes("\r\n")) { find = find.replaceAll("\n", "\r\n"); repl = repl.replaceAll("\n", "\r\n"); }
if (!s.includes(find)) { console.error("ABLATE-PATTERN-NOT-FOUND"); process.exit(9); }
fs.writeFileSync(p, s.replace(find, repl));
' "$SRC" "$FIND" "$REPL"
if [ $? -ne 0 ]; then cp "$SRC.ablate.bak" "$SRC"; rm -f "$SRC.ablate.bak"; echo "$LABEL: PATTERN NOT FOUND"; exit 1; fi
OUT=$(bun test "$TEST" 2>&1)
if [ -n "$GREP" ]; then
  echo "$LABEL:"
  echo "$OUT" | grep -E "$GREP" | sed 's/^/    /'
fi
echo "$OUT" | tail -4 | grep -E "pass|fail" | sed 's/^/    /'
cp "$SRC.ablate.bak" "$SRC"; rm -f "$SRC.ablate.bak"
