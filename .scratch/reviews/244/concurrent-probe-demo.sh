#!/usr/bin/env bash
# #244 round 4, Greptile finding 5 — the probe paths are unique per run.
#
# The complaint: `gate-set-diff.sh` and `scanner-shapes.sh` wrote FIXED probe
# paths under `apps/web/src/tests/`, so a saved probe could be overwritten or
# deleted and two concurrent runs could clobber each other. This runs the two
# scripts CONCURRENTLY and asserts that (a) both pass, and (b) neither probe path
# survives (each removed only what it created).
#
# Usage: bash .scratch/reviews/244/concurrent-probe-demo.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT" || exit 1

# A saved file at the OLD fixed path must survive: the scripts no longer touch it.
SAVED="apps/web/src/tests/__scanner-shapes.ts"
if [ -e "$SAVED" ]; then
  echo "REFUSING: $SAVED already exists; move it aside before running this demo"
  exit 1
fi
printf '// a developer saved this probe\n' > "$SAVED"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; rm -f "$SAVED"; }
trap cleanup EXIT

bash "$SCRIPT_DIR/scanner-shapes.sh" > "$TMP/shapes.out" 2>&1 &
shapes_pid=$!
bash "$SCRIPT_DIR/gate-set-diff.sh" > "$TMP/gates.out" 2>&1 &
gates_pid=$!
wait "$shapes_pid"
shapes=$?
wait "$gates_pid"
gates=$?

status=0
echo "concurrent scanner-shapes exit: $shapes"
echo "concurrent gate-set-diff exit: $gates"
if [ "$shapes" -ne 0 ] || [ "$gates" -ne 0 ]; then
  echo "PROBLEM: a concurrent probe run failed"
  tail -5 "$TMP/shapes.out" "$TMP/gates.out"
  status=1
fi

leftovers="$(find apps/web/src/tests -maxdepth 1 \( -name '__scanner-shapes.*' -o -name '__gate-set-diff*' \) -not -name "$(basename "$SAVED")" | sort)"
if [ -n "$leftovers" ]; then
  echo "PROBLEM: probe paths survived a run:"
  printf '%s\n' "$leftovers"
  status=1
fi

if [ ! -f "$SAVED" ] || ! grep -q "a developer saved this probe" "$SAVED"; then
  echo "PROBLEM: a pre-existing file at the old fixed path was overwritten or deleted"
  status=1
fi

[ "$status" -eq 0 ] && echo "concurrent-probe proof PASSED: two runs at once, both green, no leftover probe path, a saved file untouched"
exit "$status"
