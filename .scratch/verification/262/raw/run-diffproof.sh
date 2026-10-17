#!/usr/bin/env bash
# The rule-5 diff-proof: run the legacy shell and the converted TypeScript against the
# SAME inputs, and diff the output.
#
# Two of the four read live state (the CPU admission window; which lanes hold a
# worktree; which PRs are open), so a live back-to-back diff measures the machine, not
# the code. Those two are run against a FIXTURE this script builds: the legacy file is
# copied and its hardcoded constants (REPO, WT_ROOT, STATE, PIDFILE) are retargeted at
# the fixture, which is the only way to hand both versions identical inputs. The live
# runs are kept as a supplementary transcript at the end.
#
# Everything here is read-only against the real harness: `status` reads, `--dry-run`
# changes nothing, and the fixtures live under /tmp. The fixture queue is seeded with
# CREW_QUEUE_DIR (crew-queue.ts's own sandbox variable), because crew-queue.ts resolves
# its state from CREW_REPO and would otherwise write the REAL queue -- measured, and
# undone: `bun .scratch/scripts/crew-queue.ts remove 999 998 997`.
set -u
MAIN="D:/projects/mani-project"
WT="D:/projects/mani-worktrees/chore-262-shell-to-ts"
RAW="$WT/.scratch/verification/262/raw"
LEG="$WT/.scratch/verification/262/legacy"
# A NATIVE path for the fixture, not `/tmp/...`: MSYS rewrites path-valued environment
# variables when it spawns a native binary, so a `/tmp/...` fixture would hand bash and
# bun two different strings for CREW_REPO and the diff would be measuring that, not the
# code. `cygpath -m` gives the mixed form (`C:/Users/.../Temp`) both sides read the same.
FIX="$(cygpath -m "${TEMP:-/tmp}" 2>/dev/null || printf '%s' "${TEMP:-/tmp}")/crew-diff-262"
mkdir -p "$RAW"
rm -rf "$FIX"
mkdir -p "$FIX"

# The admission line and its [why] echoes carry a LIVE measurement (the CPU window and
# the e2e slot count). Masking them is the difference between diffing the code and
# diffing the machine; every other byte is compared.
mask() {
  awk '{
    sub(/budget=[0-9]+/, "budget=N")
    sub(/load [0-9.]+%/, "load N%")
    if (match($0, /admission=(ADMIT|HOLD|SHED)/)) {
      print substr($0, 1, RSTART + RLENGTH - 1) " REASON"
    } else {
      print
    }
  }' "$1"
}

echo "### 1. e2e-slot status — live shared slot dir"
( cd "$MAIN" && bash .scratch/scripts/e2e-slot.sh status ) > "$RAW/1-slot-legacy.txt" 2>&1
( cd "$WT" && bun scripts/crew/e2e-slot.ts status ) > "$RAW/1-slot-new.txt" 2>&1
if diff -u "$RAW/1-slot-legacy.txt" "$RAW/1-slot-new.txt" > "$RAW/1-slot.diff" 2>&1; then echo "IDENTICAL"; else echo "DIFFERS"; cat "$RAW/1-slot.diff"; fi

echo "### 2. crew-loop status — a fixture state dir, so the input is fixed"
LFIX="$FIX/loop"
mkdir -p "$LFIX"
sed -e "s|^STATE=.*|STATE=\"$LFIX\"|" -e "s|^PIDFILE=.*|PIDFILE=\"$LFIX/crew-loop.pid\"|" -e "s|^LOG=.*|LOG=\"$LFIX/crew-loop.log\"|" "$LEG/crew-loop.sh" > "$FIX/crew-loop-legacy.sh"
echo 999999 > "$LFIX/crew-loop.pid"
( cd "$MAIN" && bash "$FIX/crew-loop-legacy.sh" status ) > "$RAW/2a-loop-dead-legacy.txt" 2>&1
( cd "$WT" && CREW_SESSION_DIR="$LFIX" bun scripts/crew/crew-loop.ts status ) > "$RAW/2a-loop-dead-new.txt" 2>&1
if diff -u "$RAW/2a-loop-dead-legacy.txt" "$RAW/2a-loop-dead-new.txt" > "$RAW/2a-loop-dead.diff" 2>&1; then
  echo "  dead pid: IDENTICAL ($(cat "$RAW/2a-loop-dead-legacy.txt"))"
else
  echo "  dead pid: DIFFERS"
  cat "$RAW/2a-loop-dead.diff"
fi

LIVE_PID="$(cat "$MAIN/.scratch/sessions/crew/crew-loop.pid" 2>/dev/null || true)"
if [ -n "$LIVE_PID" ] && tasklist //FI "PID eq $LIVE_PID" 2>/dev/null | grep -q "$LIVE_PID"; then
  echo "$LIVE_PID" > "$LFIX/crew-loop.pid"
  ( cd "$MAIN" && bash "$FIX/crew-loop-legacy.sh" status ) > "$RAW/2b-loop-live-legacy.txt" 2>&1
  ( cd "$WT" && CREW_SESSION_DIR="$LFIX" bun scripts/crew/crew-loop.ts status ) > "$RAW/2b-loop-live-new.txt" 2>&1
  echo "  live pid $LIVE_PID (tasklist confirms bun.exe is running) — a DELIBERATE delta:"
  echo "    legacy: $(cat "$RAW/2b-loop-live-legacy.txt")"
  echo "    new:    $(cat "$RAW/2b-loop-live-new.txt")"
  echo "    measured cause: $( (cd "$MAIN" && bash -c "kill -0 $LIVE_PID") 2>&1 ) — MSYS kill cannot see a native pid, so the shell version calls a running loop dead"
else
  echo "  (live pid case skipped: no live loop pidfile)"
fi

echo "### 3. crew-clean --dry-run — FIXTURE repo with one dirty and one clean worktree"
CREPO="$FIX/clean/repo"
CWT="$FIX/clean/wt"
mkdir -p "$CREPO" "$CWT"
git -C "$CREPO" init -q -b develop
printf 'one\n' > "$CREPO/tracked.txt"
git -C "$CREPO" add tracked.txt
git -C "$CREPO" -c user.email=diff@example.invalid -c user.name=diff commit -q -m base
git -C "$CREPO" worktree add -q -b dirty-lane "$CWT/dirty-lane"
git -C "$CREPO" worktree add -q -b clean-lane "$CWT/clean-lane"
printf '// work nobody committed\n' > "$CWT/dirty-lane/unsaved-source.ts"
sed -e "s|^REPO=.*|REPO=\"$CREPO\"|" -e "s|^WT_ROOT=.*|WT_ROOT=\"$CWT\"|" "$MAIN/.scratch/scripts/crew-clean.sh" > "$FIX/crew-clean-legacy.sh"
( cd "$WT" && bash "$FIX/crew-clean-legacy.sh" --dry-run ) > "$RAW/3-clean-legacy.txt" 2>&1
( cd "$WT" && CREW_REPO="$CREPO" CREW_WT_ROOT="$CWT" bun scripts/crew/crew-clean.ts --dry-run ) > "$RAW/3-clean-new.txt" 2>&1
if diff -u "$RAW/3-clean-legacy.txt" "$RAW/3-clean-new.txt" > "$RAW/3-clean.diff" 2>&1; then echo "IDENTICAL"; else echo "DIFFERS"; cat "$RAW/3-clean.diff"; fi

echo "### 4. crew-pickup --dry-run --why — FIXTURE queue: claimable, brief-less, doubly-claimed"
PREPO="$FIX/pickup/repo"
PBRIEFS="$PREPO/.scratch/sessions/crew/briefs"
PQUEUE="$PREPO/.scratch/sessions/crew"
mkdir -p "$PREPO/.scratch/scripts" "$PBRIEFS"
cp "$MAIN/.scratch/scripts/crew-queue.ts" "$MAIN/.scratch/scripts/crew-admit.ts" "$PREPO/.scratch/scripts/"
printf '# ISSUE: **#999**\nBASE: `origin/develop`\n' > "$PBRIEFS/issue-999-diff-fixture.md"
printf '# ISSUE: **#997**\n' > "$PBRIEFS/issue-997-a.md"
printf '# ISSUE: **#997**\n' > "$PBRIEFS/issue-997-b.md"
( cd "$PREPO" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" bun .scratch/scripts/crew-queue.ts add 999 high diff-fixture >/dev/null )
( cd "$PREPO" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" bun .scratch/scripts/crew-queue.ts add 998 normal no-brief >/dev/null )
( cd "$PREPO" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" bun .scratch/scripts/crew-queue.ts add 997 low two-briefs >/dev/null )
echo "  fixture queue: $( (cd "$PREPO" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" bun .scratch/scripts/crew-queue.ts list) | tr '\n' ' ')"
sed -e "s|^REPO=.*|REPO=\"$PREPO\"|" "$MAIN/.scratch/scripts/crew-pickup.sh" > "$FIX/crew-pickup-legacy.sh"
( cd "$WT" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" timeout 300 bash "$FIX/crew-pickup-legacy.sh" --dry-run --why ) > "$RAW/4-pickup-legacy.txt" 2>&1
( cd "$WT" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" timeout 300 bun scripts/crew/crew-pickup.ts --dry-run --why ) > "$RAW/4-pickup-new.txt" 2>&1
mask "$RAW/4-pickup-legacy.txt" > "$RAW/4-pickup-legacy.masked.txt"
mask "$RAW/4-pickup-new.txt" > "$RAW/4-pickup-new.masked.txt"
if diff -u "$RAW/4-pickup-legacy.masked.txt" "$RAW/4-pickup-new.masked.txt" > "$RAW/4-pickup.diff" 2>&1; then
  echo "IDENTICAL (modulo the masked live CPU/slot measurement)"
else
  echo "DIFFERS"
  cat "$RAW/4-pickup.diff"
fi
echo "  the same fixture, unmasked, legacy:"; sed 's/^/    /' "$RAW/4-pickup-legacy.txt"
echo "  the same fixture, unmasked, new:"; sed 's/^/    /' "$RAW/4-pickup-new.txt"

echo "### 4b. crew-pickup --dry-run --why — the same fixture with the slots free, so the PER-ITEM path runs"
# crew-admit.ts reads the slot state by running the cwd's `.scratch/scripts/e2e-slot.sh`,
# so the fixture carries that script and E2E_SLOT_DIR points at an empty slot dir: two
# free slots, which is what lifts the hard cap and lets the per-item decisions show.
SLOTEMPTY="$FIX/slots-empty"
mkdir -p "$SLOTEMPTY"
cp "$MAIN/.scratch/scripts/e2e-slot.sh" "$PREPO/.scratch/scripts/"
( cd "$WT" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" E2E_SLOT_DIR="$SLOTEMPTY" E2E_SLOTS=2 timeout 300 bash "$FIX/crew-pickup-legacy.sh" --dry-run --why ) > "$RAW/4b-pickup-legacy.txt" 2>&1
( cd "$WT" && CREW_REPO="$PREPO" CREW_QUEUE_DIR="$PQUEUE" E2E_SLOT_DIR="$SLOTEMPTY" E2E_SLOTS=2 timeout 300 bun scripts/crew/crew-pickup.ts --dry-run --why ) > "$RAW/4b-pickup-new.txt" 2>&1
mask "$RAW/4b-pickup-legacy.txt" > "$RAW/4b-pickup-legacy.masked.txt"
mask "$RAW/4b-pickup-new.txt" > "$RAW/4b-pickup-new.masked.txt"
if diff -u "$RAW/4b-pickup-legacy.masked.txt" "$RAW/4b-pickup-new.masked.txt" > "$RAW/4b-pickup.diff" 2>&1; then
  echo "IDENTICAL (modulo the masked live CPU measurement)"
else
  echo "DIFFERS"
  cat "$RAW/4b-pickup.diff"
fi
echo "  legacy:"; sed 's/^/    /' "$RAW/4b-pickup-legacy.txt"
echo "  new:"; sed 's/^/    /' "$RAW/4b-pickup-new.txt"

echo "### 5. supplementary: the live queue, read-only, both sides back to back"
( cd "$MAIN" && timeout 300 bash .scratch/scripts/crew-pickup.sh --dry-run --why ) > "$RAW/5-pickup-live-legacy.txt" 2>&1
( cd "$WT" && timeout 300 bun scripts/crew/crew-pickup.ts --dry-run --why ) > "$RAW/5-pickup-live-new.txt" 2>&1
mask "$RAW/5-pickup-live-legacy.txt" > "$RAW/5-pickup-live-legacy.masked.txt"
mask "$RAW/5-pickup-live-new.txt" > "$RAW/5-pickup-live-new.masked.txt"
if diff -u "$RAW/5-pickup-live-legacy.masked.txt" "$RAW/5-pickup-live-new.masked.txt" > "$RAW/5-pickup-live.diff" 2>&1; then
  echo "IDENTICAL (modulo the masked live CPU/slot measurement)"
else
  echo "DIFFERS"
  cat "$RAW/5-pickup-live.diff"
fi
echo "### done"
