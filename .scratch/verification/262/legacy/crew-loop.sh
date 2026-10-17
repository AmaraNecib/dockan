#!/usr/bin/env bash
# crew-loop.sh — the always-on loop, for when no reload has armed crew-autopilot.
#
# Two jobs on one timer:
#   1. pickup   — run crew-pickup.sh so a lane starts as soon as the policy admits
#   2. pr watch — one `gh pr list` per tick, and wake the parent on a MEANINGFUL
#                 transition only
#
# WHAT COUNTS AS MEANINGFUL, and why the first version was wrong
# -------------------------------------------------------------
# The first version fingerprinted each check's status, so every step of a CI run
# (queued -> in_progress -> success, per check) looked like a change. A single
# push produced four or five wakes, all of them saying the same thing: nothing
# yet. A monitor that cries on every tick trains its reader to ignore it, which
# is worse than no monitor.
#
# So a wake needs one of these, and nothing else:
#   new head                  — the code moved, everything before is stale
#   new comment or review     — a Greptile verdict or a human reply landed
#   CI finished               — pending went from >0 to 0: the verdict is now real
#   CI started                — 0 to >0: a new run exists, so a re-review is coming
# Progress *within* a run wakes nobody.
#
# Started detached so it survives this session:
#   bash .scratch/scripts/crew-loop.sh start
#   bash .scratch/scripts/crew-loop.sh status
#   bash .scratch/scripts/crew-loop.sh stop
set -u

REPO="D:/projects/mani-project"
STATE="$REPO/.scratch/sessions/crew"
PIDFILE="$STATE/crew-loop.pid"
LOG="$STATE/crew-loop.log"
PRSTATE="$STATE/pr-watch-loop.json"
WAKE_BIN="${HERDR_WAKE_BIN:-$HOME/.pi/agent/bin/herdr-wake.sh}"
PARENT="${HERDR_PANE_ID:-w48:p1}"
INTERVAL="${CREW_LOOP_INTERVAL:-30}"
mkdir -p "$STATE"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG"; }

stop() {
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; say "stopped pid $pid"; fi
    rm -f "$PIDFILE"
  fi
  echo "stopped"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "running pid $(cat "$PIDFILE") — log $LOG"
  else
    echo "not running"
  fi
}

pr_changes() {
  # TypeScript now. This was a python heredoc, and it failed twice in the ways that matter:
  # a TypeError swallowed by a bare `except` left the watcher DEAD for five hours while the
  # loop logged "running", and a PR seen for the first time was baselined silently, so a
  # freshly pushed PR said nothing (#264, #265). Both classes are gone: the call shape is
  # checked, and a new PR is reported as news.
  #
  # `timeout` is still load-bearing: this is the loop's only network call and gh has no
  # timeout of its own. One hung request would stop every future tick while the loop still
  # reported "running" -- indistinguishable from working.
  timeout 180 bun "$REPO/.scratch/scripts/crew-pr-watch.ts" --state "$PRSTATE" 2>&1 || true
}

run_loop() {
  say "loop started (parent=$PARENT interval=${INTERVAL}s)"
  while true; do
    out="$(cd "$REPO" && timeout 240 bash .scratch/scripts/crew-pickup.sh 2>&1)"
    started="$(printf '%s' "$out" | sed -n 's/^\[pickup\] started=\([0-9]*\)$/\1/p')"
    # Log EVERY tick, not only the ones that start a lane. Logging only successes
    # made a throttling loop look identical to a dead one — the same
    # confident-silence failure the queue footer had.
    say "tick: $(printf '%s' "$out" | head -1 | cut -c1-160) | started=${started:-0}"
    # Log what pickup DECIDED, not just its first line. Only `head -1` ever reached the log,
    # so every per-item reason -- "no brief declares it", "already a registered worktree",
    # "started but NEVER accepted its brief" -- was discarded. That made a ticket which kept
    # failing to launch indistinguishable from one that was never eligible: both showed as
    # `started=0` and nothing else. Same confident-silence failure as the queue footer, one
    # layer down -- and it cost a real diagnosis: #258 had a brief, no worktree, and never
    # started, with no visible reason.
    detail="$(printf '%s' "$out" | grep -E '^\[pickup\]' | grep -v '^\[pickup\] started=' | tail -12)"
    [ -n "$detail" ] && say "pickup: $(printf '%s' "$detail" | tr '\n' '|' | cut -c1-500)"
    if [ "${started:-0}" -gt 0 ] 2>/dev/null; then
      # A wake carries a SUMMARY, never a raw transcript. This used to append the
      # last six lines of pickup's combined stdout+stderr, so any stray error was
      # typed straight into the parent's input box -- where the owner reads it as
      # something he must answer, and cannot tell it apart from a real message. That
      # is how `/bin/bash: D:projects...crew-pickup.sh: No such file or directory`
      # appeared in his editor. The raw output still goes to the log on every tick;
      # the wake says only what changed.
      bash "$WAKE_BIN" "$PARENT" "[autopilot] pickup started $started lane(s). Detail in .scratch/sessions/crew/crew-loop.log" >/dev/null 2>&1
    fi

    changes="$(pr_changes)"
    if [ -n "$changes" ]; then
      say "pr: $(printf '%s' "$changes" | tr '\n' '|')"
      # ACT on the verdict, don't just report it. The judgement stays in
      # crew-mergeable.ts; this only applies the consequence a human would otherwise
      # have to remember:
      #   OWNER  -> label the PR, so an unreviewed production change is visible in the
      #             PR list instead of only in a transcript nobody re-reads.
      #   AUTO   -> do NOT merge here. A background shell merging with no reasoning is
      #             harder to audit than the parent doing it while quoting the verdict;
      #             the loop labels/wakes and the parent executes. The judge is still
      #             the script either way.
      for n in $(printf '%s' "$changes" | sed -n 's/^#\([0-9]*\):.*/\1/p'); do
        v="$(cd "$REPO" && bun .scratch/scripts/crew-mergeable.ts "$n" --json 2>/dev/null)"
        [ -n "$v" ] || continue
        verdict="$(printf '%s' "$v" | bun -e 'const s=require("fs").readFileSync(0,"utf8");try{process.stdout.write(String(JSON.parse(s).verdict??""))}catch{}' 2>/dev/null)"
        case "$verdict" in
          OWNER)
            if gh pr edit "$n" --add-label needs-owner-review >/dev/null 2>&1; then
              say "#${n}: OWNER -> labelled needs-owner-review"
            fi
            ;;
          AUTO)
            say "#${n}: AUTO -> the parent may merge it (script judges, parent acts)"
            ;;
          REFUSED)
            say "#${n}: REFUSED -> $(printf '%s' "$v" | bun -e 'const s=require("fs").readFileSync(0,"utf8");try{const r=JSON.parse(s).reasons??[];process.stdout.write(r.slice(0,2).join("; "))}catch{}' 2>/dev/null)"
            ;;
        esac
      done
      bash "$WAKE_BIN" "$PARENT" "[autopilot] PR changes:
$changes

Verdicts applied by the loop (labels) — read the full verdict with:
  bun .scratch/scripts/crew-mergeable.ts <pr>
If a PR is AUTO, merge it: a script already decided, you are only executing. If OWNER, it is labelled and it is the owner's call." >/dev/null 2>&1
    fi

    sleep "$INTERVAL"
  done
}

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running pid $(cat "$PIDFILE")"; exit 0; fi
    nohup bash "$0" run >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    echo "started pid $(cat "$PIDFILE") — log $LOG"
    ;;
  run) run_loop ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: crew-loop.sh [start|stop|status]" >&2; exit 2 ;;
esac
