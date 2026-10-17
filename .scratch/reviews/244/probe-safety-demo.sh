#!/usr/bin/env bash
# #244 round 5 — Greptile finding 2: the probe instructions destroyed uncommitted
# edits. This is the failing-first demonstration.
#
#   CASE A (the OLD sequence) in a throwaway repo: overwrite the scanner with
#   `git show … > target`, restore with `git checkout -- target`, and the
#   uncommitted edit is GONE.
#
#   CASE B (the NEW probe) against this worktree: it refuses unless the target is
#   clean, then runs the probe with a marker edit applied and shows the file
#   still carries that edit afterwards (byte-identical to the marker version).
#
# The demo never uses `git checkout --` on the real scanner. It backs the file up
# to a temp dir and restores it with `cp`, verifying the sha256 before and after.
# It refuses to start when the target already has local changes, so it can never
# stomp a real uncommitted edit.
#
# Usage: bash .scratch/reviews/244/probe-safety-demo.sh
set -u
cd "$(dirname "$0")/../../.." || exit 1
TARGET="apps/web/src/tests/blankness-gates.ts"
PROBE=".scratch/reviews/244/round4-before-probe.ts"

if ! git diff --quiet -- "$TARGET" || ! git diff --cached --quiet -- "$TARGET"; then
  echo "REFUSING: $TARGET already has local changes; not touching it"
  exit 2
fi

ORIG_SHA="$(sha256sum "$TARGET" | cut -d' ' -f1)"
TMP="$(mktemp -d)"
cleanup() {
  cp "$TMP/original" "$TARGET"
  local restored
  restored="$(sha256sum "$TARGET" | cut -d' ' -f1)"
  if [ "$restored" != "$ORIG_SHA" ]; then
    echo "DANGER: restore failed ($restored != $ORIG_SHA)" >&2
    exit 3
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "### CASE A — the old sequence, in a throwaway repo"
git init -q "$TMP/old-repo"
cp "$TARGET" "$TMP/old-repo/blankness-gates.ts"
(
  cd "$TMP/old-repo" || exit 1
  git add blankness-gates.ts
  git -c user.email=demo@example.invalid -c user.name=demo commit -qm base
  printf '\n// UNCOMMITTED EDIT\n' >> blankness-gates.ts
  grep -q "UNCOMMITTED EDIT" blankness-gates.ts && echo "edit present before: yes"
  git show HEAD:blankness-gates.ts > blankness-gates.ts   # overwrite (old step 1)
  git checkout -- blankness-gates.ts                      # restore  (old step 2)
  if grep -q "UNCOMMITTED EDIT" blankness-gates.ts; then
    echo "edit present after old sequence: yes (UNEXPECTED)"
    exit 1
  fi
  echo "edit present after old sequence: no  -> the old instructions DESTROY the edit"
)
case_a=$?

echo
echo "### CASE B — the new probe, against this worktree"
cp "$TARGET" "$TMP/original"
printf '\n// UNCOMMITTED EDIT (probe-safety-demo)\n' >> "$TARGET"
MARKER_SHA="$(sha256sum "$TARGET" | cut -d' ' -f1)"
bun run "$PROBE" < /dev/null | tail -2
probe_exit=${PIPESTATUS[0]}
if [ "$probe_exit" -ne 0 ]; then
  echo "new probe exited $probe_exit (expected 0)"
  exit 1
fi
if ! grep -q "UNCOMMITTED EDIT (probe-safety-demo)" "$TARGET"; then
  echo "edit present after new probe: no (UNEXPECTED)"
  exit 1
fi
if [ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != "$MARKER_SHA" ]; then
  echo "edit present after new probe: yes, but bytes changed (UNEXPECTED)"
  exit 1
fi
echo "edit present after new probe: yes -> the new probe leaves the edit BYTE-IDENTICAL"

echo
if [ "$case_a" -eq 0 ]; then
  echo "PASSED: old sequence destroys an uncommitted edit; new probe preserves it byte-identical"
else
  echo "FAILED"
  exit 1
fi
