#!/usr/bin/env bash
# #244 round 4, Greptile finding 5 — the probe paths are unique per run.
#
# The complaint: `scanner-shapes.sh` and `gate-set-diff.sh` wrote FIXED probe
# paths under `apps/web/src/tests/`, so a saved probe could be overwritten or
# deleted and two concurrent runs could clobber each other. This is failing-first:
#
#   A. OLD scanner-shapes.sh + a saved file at the fixed path -> the saved file
#      is DELETED (the finding reproduces).
#   B. NEW scanner-shapes.sh + the same saved file + two runs at once -> both
#      green, the saved file byte-identical, no per-run probe path left behind.
#
# Usage: bash .scratch/reviews/244/concurrent-probe-demo.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OLD_SHA="1af565f"
SAVED="$ROOT/apps/web/src/tests/__scanner-shapes.ts"
MARKER="// a developer saved this probe"
FAILURES=0

# Never touch a file we did not create: this demo writes the FIXED path on
# purpose, so a real saved probe there would be destroyed. Refuse BEFORE the trap
# exists — a cleanup trap installed first would delete the file it just refused to
# touch (round-2 review).
if [ -e "$SAVED" ]; then
  echo "REFUSING: $SAVED already exists; move it aside before running this demo"
  exit 1
fi

RUN="$$-$RANDOM"
OLD_SCRIPT="$ROOT/.scratch/reviews/244/__old-scanner-shapes.$RUN.sh"
TMP="$(mktemp -d)"

cleanup() {
  rm -f "$OLD_SCRIPT"
  # $SAVED only exists because the refusal above proved it did not, and this
  # demo created it; remove it alongside the run's own temp files.
  rm -f "$SAVED"
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "########## CASE A — OLD scanner-shapes.sh, a saved probe at the fixed path ##########"
printf '%s\n' "$MARKER" > "$SAVED"
cd "$ROOT" || exit 1
git show "$OLD_SHA:.scratch/reviews/244/scanner-shapes.sh" > "$OLD_SCRIPT"
bash "$OLD_SCRIPT" > "$TMP/old.out" 2>&1
echo "old script exit code: $?"
if [ -f "$SAVED" ] && grep -q "$MARKER" "$SAVED"; then
  echo "CASE A: the saved probe SURVIVED (unexpected — the finding did not reproduce)"
  FAILURES=$((FAILURES + 1))
else
  echo "CASE A: the old fixed path DELETED the saved probe — the finding reproduces"
fi

echo
echo "########## CASE B — NEW scanner-shapes.sh, same saved probe, two runs at once ##########"
printf '%s\n' "$MARKER" > "$SAVED"
SAVED_BEFORE="$(sha256sum "$SAVED" | cut -d' ' -f1)"
cd "$ROOT" || exit 1
bash "$SCRIPT_DIR/scanner-shapes.sh" > "$TMP/new-a.out" 2>&1 &
pid_a=$!
bash "$SCRIPT_DIR/scanner-shapes.sh" > "$TMP/new-b.out" 2>&1 &
pid_b=$!
wait "$pid_a"
code_a=$?
wait "$pid_b"
code_b=$?
echo "concurrent new-script exit codes: $code_a, $code_b"
SAVED_AFTER="$(sha256sum "$SAVED" | cut -d' ' -f1)"
leftovers="$(find "$ROOT/apps/web/src/tests" -maxdepth 1 -name '__scanner-shapes.*' -not -name '__scanner-shapes.ts' | sort)"
if [ "$code_a" -eq 0 ] && [ "$code_b" -eq 0 ] \
  && [ "$SAVED_BEFORE" = "$SAVED_AFTER" ] && grep -q "$MARKER" "$SAVED" \
  && [ -z "$leftovers" ]; then
  echo "CASE B: two concurrent runs green, the saved probe byte-identical, no leftover probe path"
else
  echo "CASE B: FAILED (exits=$code_a,$code_b saved=$SAVED_BEFORE->$SAVED_AFTER leftovers='$leftovers')"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## RESULT ##########"
if [ "$FAILURES" -eq 0 ]; then
  echo "concurrent-probe demo PASSED (1 demonstrated collision, 1 required behaviour)"
else
  echo "concurrent-probe demo FAILED in $FAILURES case(s)"
fi
exit "$FAILURES"
