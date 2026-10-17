#!/usr/bin/env bash
# #244 round 5 — Greptile finding 2: the probe instructions destroyed uncommitted
# edits. This is the failing-first demonstration.
#
#   CASE A (the OLD sequence) in a throwaway repo: overwrite the scanner with
#   `git show … > target`, restore with `git checkout -- target`, and the
#   uncommitted edit is GONE.
#
#   CASE B (the NEW probe): run against a COPY of the scanner that carries a
#   marker edit, and show the probe leaves that copy byte-identical. The probe is
#   pointed at the copy with ROUND4_PROBE_TARGET, so this script never writes the
#   real scanner either; it also asserts the real file's sha256 is unchanged.
#
# There is no `git checkout --` anywhere and no write to the worktree: the demo is
# structurally unable to lose an edit, not "careful" about it.
#
# Usage: bash .scratch/reviews/244/probe-safety-demo.sh
set -u
cd "$(dirname "$0")/../../.." || exit 1
TARGET="apps/web/src/tests/blankness-gates.ts"
PROBE=".scratch/reviews/244/round4-before-probe.ts"

ORIG_SHA="$(sha256sum "$TARGET" | cut -d' ' -f1)"
if ! TMP="$(mktemp -d)"; then
  echo "mktemp -d failed; refusing to run" >&2
  exit 3
fi
trap 'rm -rf "$TMP"' EXIT INT TERM

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
  if [ ! -s blankness-gates.ts ]; then
    echo "check failed: the overwrite produced an empty file; refusing to conclude" >&2
    exit 1
  fi
  git checkout -- blankness-gates.ts                      # restore  (old step 2)
  if grep -q "UNCOMMITTED EDIT" blankness-gates.ts; then
    echo "edit present after old sequence: yes (UNEXPECTED)"
    exit 1
  fi
  echo "edit present after old sequence: no  -> the old instructions DESTROY the edit"
)
case_a=$?

echo
echo "### CASE B — the new probe, against a copy carrying a marker edit"
mkdir -p "$TMP/target"
cp "$TARGET" "$TMP/target/blankness-gates.ts"
MARK_TARGET="$TMP/target/blankness-gates.ts"
printf '\n// UNCOMMITTED EDIT (probe-safety-demo)\n' >> "$MARK_TARGET"
MARK_SHA="$(sha256sum "$MARK_TARGET" | cut -d' ' -f1)"
ROUND4_PROBE_TARGET="$MARK_TARGET" bun run "$PROBE" 2>&1 | tail -2
probe_exit=${PIPESTATUS[0]}
if [ "$probe_exit" -ne 0 ]; then
  echo "new probe exited $probe_exit (expected 0)"
  exit 1
fi
if ! grep -q "UNCOMMITTED EDIT (probe-safety-demo)" "$MARK_TARGET"; then
  echo "edit present after new probe: no (UNEXPECTED)"
  exit 1
fi
if [ "$(sha256sum "$MARK_TARGET" | cut -d' ' -f1)" != "$MARK_SHA" ]; then
  echo "edit present after new probe: yes, but bytes changed (UNEXPECTED)"
  exit 1
fi
echo "edit present after new probe: yes -> the new probe leaves the edit BYTE-IDENTICAL"

echo
if [ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != "$ORIG_SHA" ]; then
  echo "DANGER: the real $TARGET changed during the demo" >&2
  exit 3
fi
if [ "$case_a" -eq 0 ]; then
  echo "PASSED: old sequence destroys an uncommitted edit; new probe preserves one byte-identical; real target untouched"
else
  echo "FAILED"
  exit 1
fi
