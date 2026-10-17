#!/usr/bin/env bash
# crew-loop.sh — DEPRECATED, forwards to the tracked TypeScript implementation.
#
# The conversion (issue #262) moved this script to `scripts/crew/crew-loop.ts`. The
# loop's only contract with the rest of the pipeline is pickup's `[pickup] started=N`
# line, which is reproduced by `parsePickupOutcome` and pinned by
# `scripts/crew/crew-loop.test.ts`.
#
# `start` still detaches; `stop` still writes `stopped pid N` to the log.
#
# Use `bun scripts/crew/crew-loop.ts start|stop|status` from now on.
exec bun "$(dirname "$0")/../../scripts/crew/crew-loop.ts" "$@"
