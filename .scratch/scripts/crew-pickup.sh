#!/usr/bin/env bash
# crew-pickup.sh — DEPRECATED, forwards to the tracked TypeScript implementation.
#
# The conversion (issue #262) moved this script to `scripts/crew/crew-pickup.ts`:
# real argument arrays, no word splitting, a type checker over the whole thing.
#
# This file is kept, rather than deleted, because something would silently stop
# working without it: `~/.pi/agent/extensions/crew-autopilot.ts` walks up looking for
# `.scratch/scripts/crew-pickup.sh` BY NAME to decide whether the in-session autopilot
# arms at all. Delete it and the autopilot goes inert with no error, which looks
# exactly like a quiet queue.
#
# Use `bun scripts/crew/crew-pickup.ts [--dry-run|--why|--max N]` from now on.
exec bun "$(dirname "$0")/../../scripts/crew/crew-pickup.ts" "$@"
