#!/usr/bin/env bash
# #244 round 2 — prove the scope assertion has teeth.
#
# `numericReaderFiles()` defines the ratchet's scanned surface. If it silently
# shrinks, the ratchet keeps passing while a real gate leaves the surface: the
# exact "still looks green" failure this PR exists to prevent. This narrows the
# surface (drop the reader-import route) and shows the ratchet REDDENS, then
# restores the file's exact bytes.
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
OUT="$(mktemp)"
trap 'cp -p "$BACKUP" "$SCANNER"; rm -f "$BACKUP" "$OUT"' EXIT
cp -p "$SCANNER" "$BACKUP"
BEFORE="$(sha256sum "$SCANNER" | cut -d' ' -f1)"

# MUTATION: keep only the two reader modules in scope; the import route finds none.
sed -i 's|const imported = all\.filter|const imported = [].filter|' "$SCANNER"
grep -n "const imported = \[\]" "$SCANNER" || { echo "FATAL: mutation did not apply"; exit 1; }

( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
mutated=$?
echo "mutated ratchet exit code: $mutated"
grep -E '^\(fail\)|\(pass\) raw-|names only files inside the scanned scope|keeps every gate marked raw|detected gate' "$OUT" | head -12

cp -p "$BACKUP" "$SCANNER"
( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
restored=$?
echo "restored ratchet exit code: $restored"

AFTER="$(sha256sum "$SCANNER" | cut -d' ' -f1)"
leftover="$(git status --porcelain -- "$SCANNER")"
status=0
if [ "$mutated" -eq 0 ]; then
  echo "PROBLEM: a shrunken scanned surface stayed green"
  status=1
fi
if [ "$restored" -ne 0 ] || [ "$BEFORE" != "$AFTER" ] || [ -n "$leftover" ]; then
  echo "PROBLEM: did not restore $SCANNER exactly (exit=$restored bytes=$BEFORE->$AFTER leftover='$leftover')"
  status=1
fi
[ "$status" -eq 0 ] && echo "scope-shrink proof PASSED: shrink -> red, restore -> byte-identical and green"
exit "$status"
