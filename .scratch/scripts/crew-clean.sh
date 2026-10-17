#!/usr/bin/env bash
# crew-clean.sh — DEPRECATED, forwards to the tracked TypeScript implementation.
#
# The conversion (issue #262) moved this script to `scripts/crew/crew-clean.ts`. The
# five ordered guards are now a pure function (`planClean`) with a `--selftest` that
# proves each one, including the one that refuses to burn a worktree with uncommitted
# source. Nothing discovers this file by name; it is kept because a human types it.
#
# Use `bun scripts/crew/crew-clean.ts [--dry-run|--force|--keep NAME]` from now on.
exec bun "$(dirname "$0")/../../scripts/crew/crew-clean.ts" "$@"
