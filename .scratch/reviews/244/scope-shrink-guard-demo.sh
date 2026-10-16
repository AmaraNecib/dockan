#!/usr/bin/env bash
# #244 round 4, Greptile finding 4 — failing-first demonstration for the
# scope-shrink proof's guard.
#
# `scope-shrink-proof.sh` narrowed the scanned surface and accepted ANY nonzero
# exit as a detection, so a runner error during the mutated run (a crash with no
# failing test) printed PASSED. Both scripts are run against a throwaway repo in
# which the shrink makes the ratchet CRASH at import time instead of failing an
# assertion, so the real worktree is never the subject:
#
#   A. OLD script + crashing shrink -> exits 0, "scope-shrink proof PASSED"
#   B. NEW script + same crash       -> exits 1, refuses ("no expected assertion")
#
# Usage: bash .scratch/reviews/244/scope-shrink-guard-demo.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="$SCRIPT_DIR/scope-shrink-proof.sh"
OLD_SHA="1af565f"
SCRIPT_REL=".scratch/reviews/244/scope-shrink-proof.sh"
TMP="$(mktemp -d)"
FAILURES=0
trap 'rm -rf "$TMP"' EXIT

# A temp repo whose scanner contains the mutation anchor (`all.filter`) and whose
# ratchet THROWS at module scope once the surface is empty: the runner then exits
# non-zero with no `(fail)` line, which the old script counted as a detection.
setup_repo() {
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo/apps/web/src/tests" "$TMP/repo/apps/web/src/lib" "$TMP/repo/.scratch/reviews/244"
  cat > "$TMP/repo/apps/web/src/tests/blankness-gates.ts" <<'SCANNER'
const all = ["x.ts"];
const imported = all.filter(() => true);
export function numericReaderFiles(): string[] {
  return imported;
}
SCANNER
  cat > "$TMP/repo/apps/web/src/lib/blankness-ratchet.test.ts" <<'RATCHET'
import { expect, test } from "bun:test";
import { numericReaderFiles } from "../tests/blankness-gates";

const sources = numericReaderFiles();
if (sources.length === 0) throw new Error("scanned surface is empty; the scope assertion never ran");

test("keeps every raw verdict present in the source (a silent conversion reddens this)", () => {
  expect(sources).toContain("x.ts");
});
RATCHET
  cd "$TMP/repo" || exit 1
  git init -q .
  git config user.email demo@example.com
  git config user.name demo
  git config commit.gpgsign false
  git add -A
  git commit -qm "fake scanner + crash-on-empty-surface ratchet"
}

echo "########## CASE A — OLD scope-shrink-proof, runner error on the shrink ##########"
setup_repo
cd "$ROOT" || exit 1
git show "$OLD_SHA:$SCRIPT_REL" > "$TMP/repo/$SCRIPT_REL"
cd "$TMP/repo" || exit 1
bash "$SCRIPT_REL" > "$TMP/case-a.out" 2>&1
code=$?
echo "old script exit code: $code"
grep -E 'const imported = \[\]|mutated ratchet exit code|restored ratchet exit code|scope-shrink proof|PROBLEM' "$TMP/case-a.out" | head -8
if [ "$code" -eq 0 ] && grep -q 'scope-shrink proof PASSED' "$TMP/case-a.out"; then
  echo "CASE A: the unfixed script reports PASSED although no scope assertion ever failed — a proof that proves nothing"
else
  echo "CASE A: FAILED (expected a false pass, got exit $code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE B — NEW scope-shrink-proof, same runner error ##########"
setup_repo
cp -p "$SCRIPT" "$TMP/repo/$SCRIPT_REL"
cd "$TMP/repo" || exit 1
bash "$SCRIPT_REL" > "$TMP/case-b.out" 2>&1
code=$?
echo "fixed script exit code: $code"
grep -E 'baseline ratchet exit code|mutated ratchet exit code|restored ratchet exit code|PROBLEM|scope-shrink proof' "$TMP/case-b.out" | head -8
if [ "$code" -eq 1 ] && grep -q 'without the expected failing assertion' "$TMP/case-b.out"; then
  echo "CASE B: refused — a crash with no failing assertion is not a detected scope shrink"
else
  echo "CASE B: FAILED (code=$code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## RESULT ##########"
if [ "$FAILURES" -eq 0 ]; then
  echo "scope-shrink guard demo PASSED (1 demonstrated false pass, 1 required behaviour)"
else
  echo "scope-shrink guard demo FAILED in $FAILURES case(s)"
fi
exit "$FAILURES"
