#!/usr/bin/env bash
# e2e-slot.sh — DEPRECATED, forwards to the tracked TypeScript implementation.
#
# The conversion (issue #262) moved this script to `scripts/crew/e2e-slot.ts`. The
# stdout is a CONTRACT: `~/.pi/agent/extensions/e2e-slot-guard.ts` finds this file BY
# NAME, reads `^PORTS (.+)$` from it, and treats a non-zero exit as "block the heavy
# run". Both the file name and the line shape are why this shim exists.
#
# Use `bun scripts/crew/e2e-slot.ts acquire|release|status` from now on.
exec bun "$(dirname "$0")/../../scripts/crew/e2e-slot.ts" "$@"
