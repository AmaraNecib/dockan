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

git rev-parse --verify --quiet "$REF" > /dev/null || {
  echo "REFUSING: '$REF' is not a commit in this repo"
  exit 1
}
git cat-file -e "$REF:$SCANNER" 2> /dev/null || {
  echo "REFUSING: '$REF' has no $SCANNER"
  exit 1
}

BACKUP="$(mktemp)"
OUT="$(mktemp)"
trap 'cp -p "$BACKUP" "$SCANNER"; rm -f "$BACKUP" "$OUT"' EXIT
cp -p "$SCANNER" "$BACKUP"
BEFORE="$(sha256sum "$SCANNER" | cut -d' ' -f1)"

# A green baseline first: it proves the harness and the dependency install are
# healthy, so the red run below is attributable to the reference scanner rather
# than to a broken setup (the same guard the AST branch-pin proof uses).
( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
baseline=$?
if [ "$baseline" -ne 0 ]; then
  echo "FATAL: the working ratchet is not green before the reference scanner is dropped in"
  grep -E '\(fail\)|error' "$OUT" | head -10
  exit 1
fi
echo "baseline ratchet exit code: 0"

# A failed read must not leave an EMPTY scanner behind: every test would fail for
# the wrong reason and the non-zero exit would read as proof.
if ! git show "$REF:$SCANNER" > "$SCANNER"; then
  echo "FATAL: could not read $REF:$SCANNER"
  exit 1
fi
[ -s "$SCANNER" ] || {
  echo "FATAL: the reference scanner read as empty; a scan with no scanner proves nothing"
  exit 1
}

( cd apps/web && bun test src/lib/blankness-ratchet.test.ts ) > "$OUT" 2>&1
code=$?
cat "$OUT"
echo "=== reference $REF ratchet exit code: $code ==="
grep -E '\(fail\)' "$OUT" || true
grep -E '^ *[0-9]+ (pass|fail)' "$OUT" || true

# A non-zero exit is not a detection: the suite must have RUN (passing tests) and
# FAILED AN ASSERTION. An emptied scanner, a missing dependency or a crash all
# exit non-zero with no `(fail)` line, and must not read as failing-first.
passes="$(sed -n 's/^ *\([0-9][0-9]*\) pass.*$/\1/p' "$OUT" | head -1)"
fails="$(sed -n 's/^ *\([0-9][0-9]*\) fail.*$/\1/p' "$OUT" | head -1)"
if [ -z "$passes" ] || [ "$passes" -eq 0 ]; then
  echo "PROBLEM: the suite reported no passing tests; a setup error is not a failing-first proof"
  exit 1
fi
if ! grep -q '(fail)' "$OUT" || [ -z "$fails" ] || [ "$fails" -eq 0 ]; then
  echo "PROBLEM: a non-zero exit with no assertion failure is not a detection"
  exit 1
fi
echo "failing-first: $passes passed, $fails failed against $REF"

cp -p "$BACKUP" "$SCANNER"
AFTER="$(sha256sum "$SCANNER" | cut -d' ' -f1)"
leftover="$(git status --porcelain -- "$SCANNER")"
if [ "$BEFORE" != "$AFTER" ] || [ -n "$leftover" ]; then
  echo "PROBLEM: did not restore $SCANNER exactly (bytes=$BEFORE->$AFTER leftover='$leftover')"
  exit 1
fi
echo "scanner restored byte-identical"
[ "$code" -ne 0 ]
