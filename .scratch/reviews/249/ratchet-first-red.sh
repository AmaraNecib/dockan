#!/usr/bin/env bash
# #249 — failing-first against the regex scanner.
#
# Temporarily drops the reference SHA's `blankness-gates.ts` (the #244 regex
# scanner) into place, runs the ratchet, and restores the working scanner. The
# #249 fixtures that are genuinely failing-first show up as `(fail)` here; the
# #244 fixtures stay green, which is the port evidence.
#
# Never `git stash`: mktemp backup + EXIT trap, byte-identical restore.
set -u
cd "$(dirname "$0")/../../.." || exit 1
REF="${1:-ad8445f}"
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
git show "$REF:$SCANNER" > "$SCANNER"

( cd apps/web && bun test src/lib/blankness-ratchet.test.ts ) > "$OUT" 2>&1
code=$?
cat "$OUT"
echo "=== reference $REF ratchet exit code: $code ==="
grep -E '\(fail\)' "$OUT" || true
grep -E '^ *[0-9]+ (pass|fail)' "$OUT" || true

cp -p "$BACKUP" "$SCANNER"
AFTER="$(sha256sum "$SCANNER" | cut -d' ' -f1)"
leftover="$(git status --porcelain -- "$SCANNER")"
if [ "$BEFORE" != "$AFTER" ] || [ -n "$leftover" ]; then
  echo "PROBLEM: did not restore $SCANNER exactly (bytes=$BEFORE->$AFTER leftover='$leftover')"
  exit 1
fi
echo "scanner restored byte-identical"
[ "$code" -ne 0 ]
