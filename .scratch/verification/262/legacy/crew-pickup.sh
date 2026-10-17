#!/usr/bin/env bash
# crew-pickup.sh — pull the highest-priority item off the AGENT queue and start a lane.
#
# This is the step that was missing. `crew-queue.sh` is the queue and
# `crew-admit.ts` is the policy, but nothing joined them: a queue with four items
# and a 30% CPU sat there because a human had to act. That is exactly the failure
# the queue was built to remove.
#
#   crew-pickup.sh              # admit as many as the machine allows
#   crew-pickup.sh --max 1      # at most one
#   crew-pickup.sh --dry-run    # decide and print, change nothing
#
# The policy lives in ONE place: crew-admit.ts decides ADMIT / HOLD / SHED from
# the CPU window and the e2e slots. This script only asks it and obeys. It never
# re-implements a threshold, so the number in the footer and the number that
# gates a launch cannot disagree.
#
# Priority order comes from the queue file: high, then normal, then low. Two
# items of equal priority keep insertion order.
set -u

REPO="D:/projects/mani-project"
# The queue is TypeScript now, with a locked read-modify-write. It used to be bash wrapping
# python, and several processes write it -- this one on every tick, the footer extension, and
# a human by hand -- so two writers interleaved and lost one of the two updates. The symptom
# was #255 and #256 sitting in the queue while their lanes were already working, beside a
# #257 the same mechanism had removed correctly. `bun .scratch/scripts/crew-queue.ts --selftest`
# proves 24 concurrent writers all land.
QUEUE="$REPO/.scratch/scripts/crew-queue.ts"
ADMIT="$REPO/.scratch/scripts/crew-admit.ts"
BRIEFS="$REPO/.scratch/sessions/crew/briefs"
LANE_RE='^(issue|rev|pr|feat|fix|chore|refactor|docs|test|build|ci|perf|style)-'
# This repo's name, used to scope the lane count to lanes this project owns.
REPO_NAME="$(basename "$REPO")" 

# One pickup at a time. crew-autopilot.ts and crew-loop.sh can both be live, and
# two concurrent pickups would launch the same queue item twice: both would read
# the queue before either removed its entry. The lock is a directory because mkdir
# is atomic; 300s is stale enough to recover from a killed pickup and shorter than
# the time it would take a human to notice nothing was starting.
LOCK="$REPO/.scratch/sessions/crew/pickup.lock"
mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 300 ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { echo "[pickup] another pickup holds the lock."; exit 0; }
  else
    echo "[pickup] another pickup holds the lock (${age}s old); skipping this tick."
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

DRY=0; WHY=0; MAXCAP=99
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --why) WHY=1; DRY=1 ;;
    --max) shift; MAXCAP="${1:-1}" ;;
    *) echo "usage: crew-pickup.sh [--dry-run] [--max N]" >&2; exit 2 ;;
  esac
  shift
done

# ---- 1. admission: one source of truth for CPU + e2e slots -------------------
# A shorter window than the CLI default. The default samples for 60s, and this runs
# on a timer, so a 60s probe made every pickup tick take 100s+ — the loop looked
# wedged when it was only measuring. 20s is still a window (not a single sample),
# which is the property the admission decision actually needs.
decision="$(cd "$REPO" && timeout 90 bun .scratch/scripts/crew-admit.ts --json --window 20 --interval 4 2>/dev/null)" || decision=""
action="$(printf '%s' "$decision" | python -c "import json,sys; print(json.load(sys.stdin).get('action','HOLD'))" 2>/dev/null || echo HOLD)"
budget="$(printf '%s' "$decision" | python -c "import json,sys; print(json.load(sys.stdin).get('laneBudget',0))" 2>/dev/null || echo 0)"
reason="$(printf '%s' "$decision" | python -c "import json,sys; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null || echo "")"
echo "[pickup] admission=$action budget=$budget — $reason"

if [ "$action" != "ADMIT" ]; then
  echo "[pickup] holding: the policy is not admitting. Nothing started."
  # `--why` must still explain the ITEMS here. Exiting before the per-item pass made
  # the most common case -- "there is work and nothing is starting" -- print the
  # one-line host reason and no item detail, which is the case the flag exists for.
  if [ "$WHY" = "1" ]; then
    # Reuse the SAME extraction the launch path uses, so the explanation cannot drift
    # from what would actually be picked. `$reason` already reads "load 100.0% ...",
    # so it is printed as-is rather than prefixed with another "load".
    held="$(bun "$QUEUE" list 2>/dev/null | sed -n 's/^[0-9]*\. #\([0-9]*\).*/\1/p')"
    if [ -n "$held" ]; then
      echo "[why] every item below is held by the HOST, not by the queue: admission=$action ($reason)"
      for iss in $held; do
        echo "[why] #$iss: ready to pick, blocked by admission=$action ($reason)"
      done
    fi
  fi
  exit 0
fi

# ---- 2. how many lanes already exist ----------------------------------------
# An unusable budget is not a green light. `crew-admit` returned `laneBudget: null`
# (NaN through JSON) and the arithmetic below died with "unbound variable" — a crash
# in the one script that starts lanes, and a silent one: no lane, no message.
case "${budget:-}" in
  ''|*[!0-9]*) echo "[pickup] holding: admission returned an unusable budget ('${budget:-empty}')."; exit 0 ;;
esac
# Count only THIS repo's lanes. The old version counted every herdr workspace whose
# label matched the lane-name pattern, which includes the OTHER project's lanes -- so
# six tuari lanes made this project read `lanes=6 budget=6 headroom=0` and hold a full
# queue behind a budget they were not spending. A lane belongs to whichever repo its
# worktree does, so `worktree.repo_name` is the honest filter.
# NOTE the env vars belong on `python`, not on `herdr`: `A=x cmd1 | cmd2` scopes them to
# cmd1 only, so the reader would KeyError, the `|| echo 0` would swallow it, and the
# count would silently be 0 -- undercounting and oversubscribing. Caught by running the
# exact pipeline instead of trusting the edit.
running="$(herdr workspace list 2>/dev/null | REPO_NAME="$REPO_NAME" LANE_RE="$LANE_RE" python -c "
import json, os, re, sys
lane = re.compile(os.environ['LANE_RE'])
want = os.environ['REPO_NAME']
n = 0
for w in json.load(sys.stdin)['result']['workspaces']:
    label = w.get('label') or ''
    if not lane.match(label):
        continue
    if ((w.get('worktree') or {}).get('repo_name') or '') != want:
        continue
    n += 1
print(n)
" 2>/dev/null || echo 0)"
# `budget` is free CPU (cores x (1-busy) x 0.75), and the running lanes are ALREADY inside
# `busy` -- so `budget - lanes` counted them twice and held for ever on a half-idle box
# (`lanes=4 budget=4 headroom=0` at 46% busy). But `budget` alone is not the right count
# either: it would start 4 lanes in one tick and blow straight past the ceiling.
#
# The model is a THRESHOLD, not a lane count: under 80% CPU you may add a lane, at 80% you
# may not, and at 90% the lowest-priority lane is CLOSED to bring the load back down. So
# admit ONE per tick and let the next tick re-measure -- the new lane's cost is visible by
# then. Self-limiting beats a computed batch, because the measurement is the authority.
headroom=1
echo "[pickup] lanes=$running budget=$budget headroom=$headroom (one per tick under the 80% ceiling; lanes are already inside busy)"
[ "$headroom" -lt 1 ] && { echo "[pickup] holding: no headroom for another lane."; exit 0; }
[ "$headroom" -gt "$MAXCAP" ] && headroom="$MAXCAP"

# ---- 3. the queue, highest priority first ----------------------------------
# Highest priority first, and `blocked` items are not candidates at all. An item
# blocked on another PR reaching 5/5 must not be started: it would branch from
# develop, touch the same files, and collide with the PR it is waiting on.
items="$(bun "$QUEUE" list 2>/dev/null | sed -n 's/^[0-9]*\. #\([0-9]*\) .*/\1/p' | paste -d' ' - <(bun "$QUEUE" list 2>/dev/null | sed -n 's/^[0-9]*\. #[0-9]* \(\[[a-z]*\]\).*/\1/p') | awk '$2 != "[blocked]" {print $1}')"
if [ -z "$items" ]; then
  echo "[pickup] the queue is empty."
  exit 0
fi
echo "[pickup] queue: $(printf '%s ' $items)"

# Every reason an item is passed over goes through here, so a normal run stays quiet
# and `--why` explains each one. The point of `--why`: a queue holding items with a
# silent `continue` looks identical to a broken pickup, and the human cannot tell
# "blocked on another PR" from "CPU is busy" from "the script is broken".
note() { [ "$WHY" = "1" ] && echo "[why] #$1: $2"; return 0; }

started=0
for issue in $items; do
  [ "$started" -ge "$headroom" ] && break

  # A brief declares the issue it serves; the file name is the lane label. That
  # convention already exists for launch-lane.sh, so pickup reuses it rather
  # than inventing a second mapping.
  claims="$(grep -l "ISSUE: \*\*#$issue\*\*" "$BRIEFS"/*.md 2>/dev/null)"
  claim_count="$(printf '%s' "$claims" | grep -c . )"
  if [ "$claim_count" -gt 1 ]; then
    # Which brief wins must never be an accident of the alphabet. Picking one
    # silently is how a lane gets launched against a stale base with instructions
    # nobody wrote for this attempt.
    named="$(printf '%s' "$claims" | xargs -n1 basename 2>/dev/null | tr '
' ' ')"
    echo "[pickup] skip #$issue: $claim_count briefs claim it ($named) - retire all but one."
    note "$issue" "$claim_count briefs claim it: $named"
    continue
  fi
  brief="$claims"
  if [ -z "$brief" ]; then
    echo "[pickup] skip #$issue: no brief under $BRIEFS declares it."
    note "$issue" "no brief declares it (looked in $BRIEFS)"
    continue
  fi
  label="$(basename "$brief" .md)"
  if ! printf '%s' "$label" | grep -qE "$LANE_RE"; then
    echo "[pickup] skip #$issue: label '$label' does not match the lane convention."
    note "$issue" "label '$label' violates the lane naming convention"
    continue
  fi

  # A brief may declare the ref to branch from. A STACK needs this: a change that
  # depends on another PR must branch from that PR's head, not from develop, or it
  # re-implements work the other PR already carries and conflicts when they meet.
  # The rule for when stacking is allowed (the parent PR is 5/5 with no comments)
  # is the brief author's responsibility, not this script's -- pickup only obeys.
  # Strip markdown punctuation from the captured ref. A brief is PROSE, and
  # writing the base as `origin/x` in backticks is the natural thing to do -- it
  # captured the backticks as part of the ref, `worktree create --base` failed,
  # and every launch reported "started but NEVER accepted its brief".
  base="$(awk '/^BASE:/{print $2; exit}' "$brief" | tr -d '`*')"
  base="${base:-origin/develop}"
  echo "[pickup] #$issue base=$base"
  wt="/d/projects/mani-worktrees/$label"
  # A registered git worktree, NOT merely a directory. A launch that dies between
  # `git worktree add` and `herdr agent start` leaves a plain directory behind, and
  # `[ -d ]` then skips that ticket forever -- the abandoned-worktree bug, caused by
  # a crash rather than by an abandoned branch. This exact thing happened to #227:
  # the directory existed, no herdr workspace did, and the ticket sat in the queue.
  if git -C "$REPO" worktree list 2>/dev/null | grep -qF "[$label]"; then
    # A worktree with this exact label already exists, so a lane took this ticket -- it is no
    # longer work that has not STARTED, which is what this queue means. Removing it here is
    # the self-healing half of a real gap: the removal after a launch only happens when the
    # lane reaches `working` inside a short acceptance window, so a lane that was still
    # starting when pickup gave up left its ticket queued FOREVER -- every later tick took
    # this same branch and skipped, silently. Observed twice (#256 with its lane working,
    # #259 with its PR already merged).
    echo "[pickup] #$issue: '$label' is already a registered worktree -- a lane has it; removing from the queue."
    bun "$QUEUE" remove "$issue" >/dev/null 2>&1
    note "$issue" "'$label' was already a registered worktree, so a lane holds it (removed from the queue)"
    continue
  fi
  if [ -d "$wt" ]; then
    # Leftover from a failed launch: no git registration, so it cannot be used and
    # cannot be trusted. Remove it loudly rather than skip silently.
    echo "[pickup] #$issue: removing an UNREGISTERED leftover dir at $wt (failed launch)"
    # `rm -rf` is not enough on Windows. msys `rm` chokes on the long paths and
    # reparse points bun leaves under `node_modules`, so the leftover dir survives,
    # and it then blocks that ticket forever -- this is exactly what stalled #96
    # while the queue looked healthy. The native tool handles both.
    rm -rf "$wt" 2>/dev/null
    if [ -d "$wt" ]; then
      native="$(cygpath -w "$wt" 2>/dev/null || printf '%s' "$wt")"
      cmd //c "rmdir /s /q $native" >/dev/null 2>&1
    fi
    if [ -d "$wt" ]; then
      echo "[pickup] could not remove it; leaving #$issue queued."
      note "$issue" "a leftover dir at $wt could not be removed (a process is holding files); the launch is stuck here"
      continue
    fi
  fi

  if [ "$DRY" = "1" ]; then
    echo "[pickup] WOULD start #$issue as '$label' from $brief"
    started=$(( started + 1 ))
    continue
  fi

  echo "[pickup] starting #$issue as '$label'"
  # Check the exit. This used to be `>/dev/null 2>&1` with no check, so a failed
  # create still ran the mkdir, wrote a manifest, and started an agent on a pane
  # that never existed -- reported as "started but NEVER accepted its brief", with
  # a leftover directory that then blocked the ticket. A launch that cannot create
  # its worktree must stop HERE and leave the item queued.
  if ! create_out="$(herdr worktree create --cwd "$REPO" --base "$base" --branch "$label" \
      --path "D:/projects/mani-worktrees/$label" --label "$label" --no-focus 2>&1)"; then
    echo "[pickup] #$issue: worktree create FAILED; left in the queue. $(printf '%s' "$create_out" | head -c 200)"
    continue
  fi
  case "$create_out" in
    *'"error"'*) echo "[pickup] #$issue: worktree create returned an error; left in the queue. $(printf '%s' "$create_out" | head -c 200)"; continue ;;
  esac
  res="$(herdr worktree open --cwd "$REPO" --path "D:/projects/mani-worktrees/$label" --label "$label" --no-focus 2>&1)"
  pane="$(printf '%s' "$res" | grep -oE '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "${pane:-}" ]; then
    echo "[pickup] #$issue: no pane came back from worktree open; left in the queue. $(printf '%s' "$res" | head -c 200)"
    continue
  fi
  mkdir -p "$wt/.scratch/sessions/crew"
  printf '{\n  "parentPaneId": "%s",\n  "parentWorkspaceId": "%s",\n  "issue": "%s",\n  "launchedAt": "%s"\n}\n' \
    "${HERDR_PANE_ID:-w48:p1}" "${HERDR_WORKSPACE_ID:-w48}" "$issue" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$wt/.scratch/sessions/crew/$label.manifest.json"

  # Start the agent BARE, then deliver the brief through the one mechanism that proves
  # delivery. Two attempts at the other way both failed, for different reasons:
  #   * `herdr agent prompt <label> <MSG> >/dev/null 2>&1` -- rejected silently (mid-dialog
  #     or no session), and the only symptom was an idle lane with a queued ticket;
  #   * `herdr agent start ... -- "$MSG"` -- herdr refuses it outright:
  #     "invalid_agent_argument: agent arguments cannot be encoded safely for the target shell".
  #     A multi-line brief with backticks cannot be passed as an argv element.
  if ! herdr agent start "$label" --kind pi --pane "$pane" --timeout 120000 >/dev/null 2>&1; then
    echo "[pickup] #$issue: agent start failed; leaving #$issue queued."
    continue
  fi

  # Deliver through herdr-wake.sh, which PROVES delivery and retries while the target
  # is mid-dialog. The old line was `herdr agent prompt "$label" "$MSG" >/dev/null 2>&1`
  # -- output suppressed, so a rejected prompt was invisible -- and its only symptom was
  # an idle lane with the ticket still queued. Observed twice in one night (#249,
  # #244 round 5): the agent had started, had a session, and had never been told anything.
  # The launch message. It is REBUILT here on purpose, and the guard below is the reason:
  # a previous edit of this block deleted the definition while keeping every use of it, so
  # pickup sent an EMPTY prompt. herdr accepted it (exit 0, because an empty submission is
  # perfectly valid), the lane stayed idle, and three worktrees were created and abandoned
  # with nothing in their sessions. "Did the command succeed" cannot catch that; "did the
  # lane go to work" can, and so can refusing to send nothing at all.
  MSG="CREW LANE — issue #$issue.
THE BRIEF IS THE SPECIFICATION: read $brief and follow it over anything in this message. Its acceptance criteria are what you build and prove.
Then read .agents/skills/feature-implement/SKILL.md, then docs/engineering-workflow.md.
LESSONS: read .agents/wisdom/README.md and grep .agents/wisdom/ for what bears on this task. Name the lessons you applied and the ones you deliberately did not, with the reason.
AUTHORITY: commit only. The parent owns push, PR, review and merge. Never write .agents/wisdom/ — report a candidate lesson in crew_report instead.
EVIDENCE (the standing rule, issue #259): if the change is VISUAL, leave before/after images AND a video at real user pace. If it is NOT visual, leave the MEASUREMENTS — the failing-first run (red before, green after) with the failing assertion named, the ablation proof that any new guard actually bites, before/after numbers, and the decisions you took with the reason. A test that never failed proves nothing. Put it in the commit message body and summarise it in crew_report.
PATHS: the shared e2e slot script is $REPO/.scratch/scripts/e2e-slot.sh — the MAIN repo, never your worktree. NEVER search from / or D:\; two \`find / -name e2e-slot.sh\` scans ran for an hour each and pinned the box. Scope every find/grep/rg to the repo root or a subdirectory.
CODEMODE -- USE IT AS MUCH AS POSSIBLE, IT IS THE DEFAULT. Reach for it first, not last: one codemode script replaces a chain of shell commands and file reads, collapses a sweep or an enumeration into a single step, and returns only the table instead of a wall of output. Write the script, run it, read the result.
Fall back to plain bash/read/edit ONLY when codemode cannot do the job, or when using it would be HEAVIER or MORE EXPENSIVE than doing it directly -- editing a file, running one command whose output IS the answer, or needing the full control flow of a single file. Falling back is correct in those cases; skipping codemode out of habit is not. State in your report where you used codemode and where you did not, and why.
Run bun install first. Commit before reporting, then crew_report with the commit SHA and the evidence."

  if [ -z "$MSG" ] || [ ! -f "$brief" ]; then
    echo "[pickup] #$issue: refusing to launch — empty message or missing brief ($brief); leaving it queued."
    continue
  fi

  accepted=0
  WAKE="$HOME/.pi/agent/bin/herdr-wake.sh"
  for _ in 1 2 3; do
    # `--wait` blocks until herdr has accepted the submission, so a rejection is
    # reported here instead of vanishing. This is the primary path.
    if ! out="$(herdr agent prompt "$label" "$MSG" --wait 2>&1)"; then
      echo "[pickup] #$issue: prompt was NOT accepted: $(printf '%s' "$out" | head -c 140)"
      # Fallback: the wake script waits out a mid-dialog target and proves delivery.
      [ -x "$WAKE" ] && bash "$WAKE" "$pane" "$MSG" 60 5 >/dev/null 2>&1
    fi
    sleep 8
    st="$(herdr workspace list 2>/dev/null | LABEL="$label" bun -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const w of d.result.workspaces){if(w.label===process.env.LABEL){console.log(w.agent_status||"");break}}' 2>/dev/null)"
    case "$st" in working|done) accepted=1; break ;; esac
  done

  if [ "$accepted" = "1" ]; then
    # Out of the queue only once a lane actually took it: a launch that never
    # accepted its brief must not silently delete the work item.
    bun "$QUEUE" remove "$issue" >/dev/null 2>&1
    echo "[pickup] #$issue -> $label ($pane) accepted; removed from queue"
    started=$(( started + 1 ))
  else
    # DO NOT leave the worktree registered. It used to stay, and the next tick then
    # reported "already a registered worktree" and skipped the ticket -- forever. A
    # failed launch must be reversible, or it is a deadlock rather than a delay.
    echo "[pickup] #$issue -> $label started but NEVER accepted its brief; tearing the launch down so the ticket can retry"
    git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
    [ -d "$wt" ] && cmd //c "rmdir /s /q $(cygpath -w "$wt" 2>/dev/null || echo "$wt")" >/dev/null 2>&1
    git -C "$REPO" worktree prune >/dev/null 2>&1
    git -C "$REPO" branch -D "$label" >/dev/null 2>&1
    wid="$(herdr workspace list 2>/dev/null | LABEL="$label" bun -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const w of d.result.workspaces){if(w.label===process.env.LABEL){console.log(w.workspace_id||"");break}}' 2>/dev/null)"
    [ -n "${wid:-}" ] && herdr workspace close "$wid" >/dev/null 2>&1
    echo "[pickup] #$issue left in the queue; next tick may retry it"
  fi
done

if [ "$WHY" = "1" ]; then
  echo "[pickup] --- why: admission=$action budget=$budget headroom=$headroom lanes=$running ---"
  [ "$action" != "ADMIT" ] && echo "[why] EVERY item: admission=$action ($reason) - the host, not the queue"
fi
echo "[pickup] started=$started"
