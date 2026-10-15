#!/usr/bin/env bash
# e2e-slot.sh — serialise the heavy Playwright runs across crew lanes.
#
# Why: a full `bun run test:e2e` boots four servers and saturates the CPU. More
# than a couple at once makes the GUARDS flaky, and a flaky guard costs more time
# than it saves (2026-10-13: five lanes fought over the shared dev ports and every
# one of them reported a false failure). A lane may always run cheap tests
# (typecheck, lint, unit, a single spec) with no slot at all.
#
# The lock lives in ONE shared directory (the main repo, not a worktree), because
# each worktree has its own `.scratch`.
#
# Usage:
#   e2e-slot.sh acquire <lane> [--timeout SECONDS] [--no-wait]
#   e2e-slot.sh release <lane>
#   e2e-slot.sh status
#
# `acquire` prints the port quartet to export, then exits 0. If it cannot get a
# slot inside the timeout it exits 2 and the caller must NOT run e2e: commit and
# report instead, and the next lane's release frees the slot.
#
# Slots are FIRST COME, FIRST SERVED by request time, and each slot owns a
# DISJOINT port quartet, so two concurrent runs cannot fight over ports either.
set -u

ROOT="${E2E_SLOT_DIR:-/d/projects/mani-project/.scratch/sessions/crew/e2e-slots}"
SLOTS="${E2E_SLOTS:-2}"
HELD="$ROOT/held"
QUEUE="$ROOT/queue"

mkdir -p "$HELD" "$QUEUE"

# The caller's queue ticket. Global (not a function local) so a trap can see it.
MINE=""

# A slot whose owner died (killed lane, slept laptop, backgrounded run) must not
# stall everyone behind it. E2E_SLOT_MAX_HOLD is generous: a full suite is ~9 min.
MAX_HOLD="${E2E_SLOT_MAX_HOLD:-1800}"
reap_held() {
  local d since now
  now="$(date -u +%s)"
  for d in "$HELD"/*; do
    [ -d "$d" ] || continue
    since="$(date -u -d "$(cat "$d/since" 2>/dev/null)" +%s 2>/dev/null)" || continue
    if [ $(( now - since )) -gt "$MAX_HOLD" ]; then
      echo "reaped stale $(basename "$d") (held by $(cat "$d/lane" 2>/dev/null), ${MAX_HOLD}s)" >&2
      rm -rf "$d"
    fi
  done
}

# Base for this slot's port quartet. Slot 1 -> 4701/5701, slot 2 -> 4801/5801, ...
ports_for() {
  # Two statements on purpose: bash expands every word of a `local` before
  # performing any of its assignments, so `local slot="$1" base=$(( ...slot... ))`
  # reads `slot` before it is set (unbound under `set -u`).
  local slot="$1"
  local base=$(( 4600 + slot * 100 ))
  printf 'DOKAN_PORT=%s DOKAN_WEB_PORT=%s DOKAN_VAULT_PORT=%s DOKAN_VAULT_WEB_PORT=%s' \
    "$base" "$(( base + 1000 ))" "$(( base + 1 ))" "$(( base + 1001 ))"
}

# The slot dir a lane currently holds, or empty.
slot_of() {
  local lane="$1" d
  for d in "$HELD"/*; do
    [ -d "$d" ] || continue
    [ "$(cat "$d/lane" 2>/dev/null)" = "$lane" ] && { basename "$d"; return; }
  done
}

status() {
  local d n=0
  reap_held
  echo "slots: $SLOTS   root: $ROOT"
  for d in "$HELD"/*; do
    [ -d "$d" ] || continue
    n=$(( n + 1 ))
    printf '  HELD  %-6s lane=%s since=%s\n' "$(basename "$d")" \
      "$(cat "$d/lane" 2>/dev/null)" "$(cat "$d/since" 2>/dev/null)"
  done
  [ "$n" -eq 0 ] && echo "  (none held)"
  for d in "$QUEUE"/*; do
    [ -f "$d" ] || continue
    printf '  QUEUE %-6s lane=%s asked=%s\n' "$(basename "$d" .req)" \
      "$(cut -d' ' -f2- "$d" 2>/dev/null)" "$(cut -d' ' -f1 "$d" 2>/dev/null)"
  done
}

acquire() {
  local lane="$1" timeout="$2" nowait="$3"

  # An existing slot is a no-op, so a re-run never deadlocks against itself.
  local have; have="$(slot_of "$lane")"
  if [ -n "$have" ]; then
    echo "PORT_SLOT=$have already held by $lane"
    echo "PORTS $(ports_for "${have#slot}")"
    return 0
  fi

  # Reuse this lane's own request if it already queued, so retrying does not
  # push the lane to the back behind its own abandoned ticket.
  MINE="$(ls "$QUEUE"/*-"$lane".req 2>/dev/null | sort | head -1)"
  if [ -z "$MINE" ]; then
    MINE="$QUEUE/$(date -u +%Y%m%dT%H%M%S)-$$-$lane.req"
    printf '%s %s\n' "$(date -u +%s)" "$lane" > "$MINE"
  fi
  # A killed lane must not block the queue: reap tickets that stopped polling.
  find "$QUEUE" -name '*.req' -mmin +2 -delete 2>/dev/null || true

  local deadline=$(( $(date -u +%s) + timeout ))
  while :; do
    reap_held
    # Activity marker: reaping above uses mtime, so a live waiter stays fresh.
    touch "$MINE" 2>/dev/null || true
    local oldest; oldest="$(ls "$QUEUE"/*.req 2>/dev/null | sort | head -1)"
    local held; held="$(ls -d "$HELD"/* 2>/dev/null | wc -l)"
    if [ "$oldest" = "$MINE" ] && [ "$held" -lt "$SLOTS" ]; then
      local n
      for n in $(seq 1 "$SLOTS"); do
        # mkdir is the atomic claim: only one process can create the directory.
        if mkdir "$HELD/slot$n" 2>/dev/null; then
          printf '%s' "$lane" > "$HELD/slot$n/lane"
          date -u +%Y-%m-%dT%H:%M:%SZ > "$HELD/slot$n/since"
          rm -f "$MINE"; MINE=""
          echo "PORT_SLOT=slot$n held by $lane"
          echo "PORTS $(ports_for "$n")"
          return 0
        fi
      done
    fi
    if [ "$nowait" = "1" ] || [ "$(date -u +%s)" -ge "$deadline" ]; then
      echo "PORT_SLOT=none ($lane still queued; held=$held/$SLOTS)"
      return 2
    fi
    sleep 10
  done
}

release() {
  local lane="$1" d
  for d in "$HELD"/*; do
    [ -d "$d" ] || continue
    if [ "$(cat "$d/lane" 2>/dev/null)" = "$lane" ]; then
      rm -rf "$d"
      echo "released $(basename "$d") from $lane"
      rm -f "$QUEUE"/*-"$lane".req 2>/dev/null
      return 0
    fi
  done
  rm -f "$QUEUE"/*-"$lane".req 2>/dev/null
  echo "no slot held by $lane"
}

case "${1:-}" in
  acquire)
    lane="${2:?usage: e2e-slot.sh acquire <lane> [--timeout SECONDS] [--no-wait]}"
    timeout=1800; nowait=0
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --timeout) timeout="${2:?}"; shift 2 ;;
        --no-wait) nowait=1; shift ;;
        *) shift ;;
      esac
    done
    acquire "$lane" "$timeout" "$nowait"
    ;;
  release) release "${2:?usage: e2e-slot.sh release <lane>}" ;;
  status)  status ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
