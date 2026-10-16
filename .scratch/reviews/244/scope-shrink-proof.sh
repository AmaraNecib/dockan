#!/usr/bin/env bash
# #244 round 2 — prove the scope assertion has teeth.
#
# `numericReaderFiles()` defines the ratchet's scanned surface. If it silently
# shrinks, the ratchet keeps passing while a real gate leaves the surface: the
# exact "still looks green" failure this PR exists to prevent. This narrows the
# surface (drop the reader-import route) and shows the ratchet REDDENS, then
# restores the file's exact bytes.
#
# Round 4 (Greptile finding 4): a NON-ZERO mutated run is not a detection. The
# script now requires
#   * a GREEN baseline before the mutation, and
#   * the EXPECTED failing assertion — the scope one, "names only files inside the
#     scanned scope" — in the mutated output, read BEFORE the restored run
#     overwrites it. (The raw-verdict test fails with it, but the scope assertion
#     is what this proof is about.)
# A runner error during the mutated run (a crash with no failing test) therefore
# fails the proof instead of printing PASSED.
#
# Never `git stash`; the file is backed up to a mktemp copy and restored on EXIT.
set -u
cd "$(dirname "$0")/../../.." || exit 1
SCANNER="apps/web/src/tests/blankness-gates.ts"

[ -z "$(git status --porcelain -- "$SCANNER")" ] || {
  echo "REFUSING: $SCANNER has uncommitted changes"
  exit 1
}

BACKUP="$(mktemp)"
OUT_MUTATED="$(mktemp)"
OUT_RESTORED="$(mktemp)"
trap 'cp -p "$BACKUP" "$SCANNER"; rm -f "$BACKUP" "$OUT_MUTATED" "$OUT_RESTORED"' EXIT
cp -p "$SCANNER" "$BACKUP"
BEFORE="$(sha256sum "$SCANNER" | cut -d' ' -f1)"

# Green baseline first: a suite that is already red proves nothing about a shrink.
( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT_RESTORED" 2>&1 )
baseline=$?
if [ "$baseline" -ne 0 ]; then
  echo "FATAL: the ratchet is not green before any scope shrink"
  grep -E '\(fail\)|error' "$OUT_RESTORED" | head -10
  exit 1
fi
echo "baseline ratchet exit code: 0"

# MUTATION: keep only the two reader modules in scope; the import route finds none.
sed -i 's|const imported = all\.filter|const imported = [].filter|' "$SCANNER"
grep -n "const imported = \[\]" "$SCANNER" || { echo "FATAL: mutation did not apply"; exit 1; }

( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT_MUTATED" 2>&1 )
mutated=$?
echo "mutated ratchet exit code: $mutated"
grep -E '^\(fail\)' "$OUT_MUTATED" | head -12

# Read the mutated output BEFORE restoring over a fresh run: a nonzero exit with
# no failing assertion is a crashed runner, not a detected scope shrink.
status=0
if [ "$mutated" -eq 0 ]; then
  echo "PROBLEM: a shrunken scanned surface stayed green"
  status=1
elif ! grep -qE '\(fail\).*names only files inside the scanned scope' "$OUT_MUTATED"; then
  echo "PROBLEM: exit $mutated without the expected failing assertion — a crashed runner is not a detection"
  status=1
fi

cp -p "$BACKUP" "$SCANNER"
( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT_RESTORED" 2>&1 )
restored=$?
echo "restored ratchet exit code: $restored"

AFTER="$(sha256sum "$SCANNER" | cut -d' ' -f1)"
leftover="$(git status --porcelain -- "$SCANNER")"
if [ "$restored" -ne 0 ] || [ "$BEFORE" != "$AFTER" ] || [ -n "$leftover" ]; then
  echo "PROBLEM: did not restore $SCANNER exactly (exit=$restored bytes=$BEFORE->$AFTER leftover='$leftover')"
  status=1
fi
[ "$status" -eq 0 ] && echo "scope-shrink proof PASSED: shrink -> red on the scope assertion, restore -> byte-identical and green"
exit "$status"
