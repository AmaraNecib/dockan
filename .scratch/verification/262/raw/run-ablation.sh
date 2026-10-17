#!/usr/bin/env bash
# run-ablation.sh — prove each new guard actually bites.
#
# For every guard the conversion added or moved, delete exactly that guard, run the
# selftest that is supposed to cover it, and record the failing assertion. Restore, then
# the next one. A guard whose case stays green after the guard is gone is decoration.
set -u
cd "D:/projects/mani-worktrees/chore-262-shell-to-ts" || exit 1
BACKUP="$(mktemp -d)"

run_one() {
  local name="$1" file="$2" script="$3" label="$4"
  cp "$file" "$BACKUP/$(basename "$file")"
  echo "== ABLATION: $label"
  if ! bun .scratch/verification/262/raw/mutate.ts "$name"; then
    echo "   (pattern not found; nothing mutated)"
    cp "$BACKUP/$(basename "$file")" "$file"
    return
  fi
  bun "$script" --selftest 2>&1 | grep -E '^FAIL|pass /' | head -6 | sed 's/^/   /'
  cp "$BACKUP/$(basename "$file")" "$file"
}

run_one pickup-guard scripts/crew/crew-pickup.ts scripts/crew/crew-pickup.ts \
  "pickup: the empty-message guard is deleted (the historical bug: herdr accepted an empty prompt at exit 0)"
run_one clean-guard scripts/crew/crew-clean.ts scripts/crew/crew-clean.ts \
  "crew-clean: the uncommitted-source guard is deleted (the destructive path)"
run_one loop-parse scripts/crew/crew-loop.ts scripts/crew/crew-loop.ts \
  "crew-loop: the started= parse is broken (the contract with pickup)"
run_one slot-atomic scripts/crew/e2e-slot.ts scripts/crew/e2e-slot.ts \
  "e2e-slot: the mkdir claim stops being atomic (the lock itself)"

echo "== restored:"
git status --short scripts/crew/ | sed 's/^/   /'
rm -rf "$BACKUP"
