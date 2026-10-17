#!/usr/bin/env bash
# herdr-wake.sh — DEPRECATED, forwards to the tracked TypeScript implementation.
#
# The conversion (issue #262) moved this script to `scripts/crew/herdr-wake.ts`, which
# parses herdr's reply in-process instead of piping it through `jq`. That is not
# tidiness: a machine without `jq` produced the same empty state as a pane that was
# gone, so a missing toolchain read as "no agent at ..." and exit 3.
#
# INSTALL: this file lives outside every repository, so it cannot be converted in
# place. Copy it to the caller's location:
#
#   cp scripts/crew/herdr-wake.sh ~/.pi/agent/bin/herdr-wake.sh
#
# Resolution order: $HERDR_WAKE_TS, this script's own directory, its repo's
# `scripts/crew/`, then the main repo's tracked copy. Every caller passes the message
# as an argument, never through a shell string.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in \
  "${HERDR_WAKE_TS:-}" \
  "$here/herdr-wake.ts" \
  "$here/../scripts/crew/herdr-wake.ts" \
  "/d/projects/mani-project/scripts/crew/herdr-wake.ts"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    exec bun "$candidate" "$@"
  fi
done
echo "herdr-wake: no herdr-wake.ts found (set HERDR_WAKE_TS to the TypeScript entry)" >&2
exit 3
