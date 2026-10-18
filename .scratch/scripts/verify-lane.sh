#!/usr/bin/env bash
# verify-lane.sh - check a lane's handoff claims against the worktree itself.
#
# A lane says "HEAD 375788b, 1002 tests pass, three lenses run". This checks the parts
# that can be checked cheaply and mechanically, so the parent only has to think about the
# parts that cannot be. It does not judge the code; it judges whether the report is true.
#
# Usage:
#   verify-lane.sh <worktree-path> <issue-id> [claimed-head-sha]
#
# Exit 0 = every check passed. Exit 1 = at least one claim failed (see the FAIL lines).
# Exit 2 = bad arguments / not a worktree.

set -uo pipefail

WT="${1:-}"
ISSUE="${2:-}"
CLAIMED="${3:-}"

if [ -z "$WT" ] || [ -z "$ISSUE" ]; then
  echo "usage: verify-lane.sh <worktree-path> <issue-id> [claimed-head-sha]" >&2
  exit 2
fi
if [ ! -d "$WT" ]; then
  echo "FAIL: no such worktree: $WT" >&2
  exit 2
fi
if ! git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "FAIL: not a git worktree: $WT" >&2
  exit 2
fi

fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
info() { printf '  ..    %s\n' "$1"; }

HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
HEAD_SHORT="$(git -C "$WT" rev-parse --short HEAD)"
BRANCH="$(git -C "$WT" branch --show-current)"
echo "=== verify lane: issue #$ISSUE ==="
echo "  worktree: $WT"
echo "  branch:   $BRANCH"
echo "  head:     $HEAD_SHORT"
echo

echo "-- 1. the head it claims"
if [ -n "$CLAIMED" ]; then
  # accept a short or full sha, and any prefix match
  case "$HEAD_SHA" in
    "$CLAIMED"*) pass "HEAD matches the reported sha ($CLAIMED)" ;;
    *)           fail "HEAD is $HEAD_SHA but the report claims $CLAIMED" ;;
  esac
else
  info "no sha claimed; skipping"
fi

echo "-- 2. the work is committed, not just on disk"
dirty="$(git -C "$WT" status --porcelain | grep -v '^?? \.scratch/' | grep -v '^?? \.pi/' || true)"
if [ -z "$dirty" ]; then
  pass "no uncommitted tracked changes"
else
  fail "uncommitted changes present (a lane that reports a head must have committed it):"
  printf '%s\n' "$dirty" | sed 's/^/          /'
fi

echo "-- 3. commits carry provenance trailers"
mapfile -t COMMITS < <(git -C "$WT" log --format='%H' origin/develop..HEAD 2>/dev/null || git -C "$WT" log --format='%H' -5)
if [ "${#COMMITS[@]}" -eq 0 ]; then
  fail "no commits ahead of origin/develop - nothing to land"
else
  info "${#COMMITS[@]} commit(s) ahead of origin/develop"
  for c in "${COMMITS[@]}"; do
    short="$(git -C "$WT" rev-parse --short "$c")"
    t="$(git -C "$WT" log -1 --format='%(trailers:key=Model,valueonly)%(trailers:key=Thinking,valueonly)%(trailers:key=Harness,valueonly)%(trailers:key=Agent,valueonly)' "$c")"
    missing=""
    for k in Model Thinking Harness Agent; do
      v="$(git -C "$WT" log -1 --format="%(trailers:key=$k,valueonly)" "$c")"
      [ -z "$v" ] && missing="$missing $k"
    done
    if [ -z "$missing" ]; then pass "$short has all four trailers"; else fail "$short missing trailer(s):$missing"; fi
  done
fi

echo "-- 4. review evidence for THIS head"
EV=".scratch/reviews/$ISSUE"
if [ ! -d "$WT/$EV" ]; then
  fail "no evidence directory at $EV - the lenses have not run"
else
  for lens in debate test-audit code-review; do
    hit="$(ls "$WT/$EV" 2>/dev/null | grep -i "$lens" | grep -i "$HEAD_SHORT" | head -1 || true)"
    if [ -z "$hit" ]; then
      # a lens may name a short head without letters matching case; retry loosely
      any="$(ls "$WT/$EV" 2>/dev/null | grep -i "$lens" | head -1 || true)"
      if [ -n "$any" ]; then
        fail "$lens evidence exists but names a different head: $any (need $HEAD_SHORT)"
      else
        fail "$lens evidence missing for $HEAD_SHORT"
      fi
    else
      sz="$(wc -c < "$WT/$EV/$hit" | tr -d ' ')"
      if [ "$sz" -lt 300 ]; then
        fail "$lens evidence is only ${sz} bytes - too thin to be a review"
      else
        pass "$lens evidence present for $HEAD_SHORT (${sz} bytes)"
      fi
    fi
  done
fi

echo "-- 5. does the evidence actually name this head inside the file?"
if [ -d "$WT/$EV" ]; then
  named=0
  for f in "$WT/$EV"/*"$HEAD_SHORT"*; do
    [ -f "$f" ] || continue
    if grep -q "$HEAD_SHORT" "$f"; then named=$((named + 1)); fi
  done
  if [ "$named" -gt 0 ]; then pass "$named evidence file(s) reference $HEAD_SHORT in their text"; else info "no evidence file mentions $HEAD_SHORT (fine if the filename carries it)"; fi
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "RESULT: all checks passed. The lane's report is consistent with the worktree."
  echo "        This does NOT prove the code is right - read the diff and the evidence."
  exit 0
else
  echo "RESULT: $fails check(s) failed. Do not push this branch on the strength of the report."
  exit 1
fi
