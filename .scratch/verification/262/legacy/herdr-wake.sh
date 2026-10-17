#!/usr/bin/env bash
# herdr-wake.sh <target> <message> [deadline-seconds] [poll-seconds]
#
# Deliver a message to a Pi pane and PROVE it landed.
#
# Why this exists
# ---------------
# `herdr agent prompt` REJECTS a submission *before any input is sent* when the
# target is mid-dialog (`agent_blocked`), and refuses outright when the target is
# gone (`agent_not_found`). Its own --help says so.
#
# Every caller used to run the prompt, log it, and `exit 0` regardless. So a
# wake that was never delivered left exactly the same trace as one that was: a
# log line and a zero exit. A crew lane's report or a CI verdict could vanish
# with nothing to notice. Four callers shared the bug:
#
#   ~/.pi/agent/extensions/crew-watch.ts        (the crew_report tool)
#   .scratch/scripts/gh-pr-watch-settle.sh
#   .scratch/scripts/gh-pr-watch.sh
#   .scratch/scripts/gh-run-watch.sh
#
# Policy
# ------
#   target missing        -> exit 3 immediately; retrying cannot help
#   target blocked        -> wait and retry until the deadline. Blocked means a
#                            human has to dismiss a dialog; that is a delay, not
#                            a reason to throw the message away.
#   target idle/working   -> submit; retry on a refusal
#   deadline exceeded     -> exit 2, loudly. NEVER a false zero.
#
# `delivered` means herdr accepted the input and handed it to the target. For a
# working target Pi queues it as a steering message, which enters after the
# current turn -- it is not proof the target has *read* it.
#
# Exit codes: 0 delivered | 2 stayed blocked | 3 target missing/refused | 4 usage
set -u

TARGET="${1:?usage: herdr-wake.sh <target> <message> [deadline-s] [poll-s]}"
MESSAGE="${2:?usage: herdr-wake.sh <target> <message> [deadline-s] [poll-s]}"
DEADLINE="${3:-900}"   # 15 minutes by default
POLL="${4:-15}"

command -v herdr >/dev/null 2>&1 || { echo "herdr-wake: herdr not on PATH" >&2; exit 3; }

state() {
  herdr agent get "$TARGET" 2>/dev/null | jq -r '.result.agent.agent_status // empty' 2>/dev/null
}

# A missing target and a missing jq look the same from state(); separate them
# once so a broken toolchain cannot masquerade as a gone pane.
if ! command -v jq >/dev/null 2>&1; then
  echo "herdr-wake: jq not on PATH" >&2
  exit 3
fi

start="$(date +%s)"
refusals=0
while :; do
  now="$(date +%s)"
  if [ "$((now - start))" -ge "$DEADLINE" ]; then
    if [ "$(state)" = "blocked" ]; then
      echo "herdr-wake: '$TARGET' stayed blocked for ${DEADLINE}s; message NOT delivered" >&2
      exit 2
    fi
    echo "herdr-wake: deadline ${DEADLINE}s reached without a delivery to '$TARGET'" >&2
    exit 3
  fi

  st="$(state)"
  case "$st" in
    "")
      # No agent state at all: the pane is gone, or is not an agent.
      echo "herdr-wake: no agent at '$TARGET'" >&2
      exit 3
      ;;
    blocked)
      # Someone must dismiss a dialog. Waiting is correct; discarding is not.
      sleep "$POLL"
      continue
      ;;
  esac

  if herdr agent prompt "$TARGET" "$MESSAGE" >/dev/null 2>&1; then
    exit 0
  fi

  refusals=$((refusals + 1))
  # A refusal on an idle/ready target is a race, not a policy: retry, but do not
  # spin forever on something that will clearly never be accepted.
  if [ "$refusals" -ge 5 ]; then
    echo "herdr-wake: '$TARGET' refused the submission ${refusals}x (state=$st)" >&2
    exit 3
  fi
  sleep "$POLL"
done
