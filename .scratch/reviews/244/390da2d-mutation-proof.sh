#!/usr/bin/env bash
# #244 mutation proof: revert each converted source file to its raw-.trim() form
# (HEAD vs the pre-conversion BASE), run the ratchet, and capture the failure.
# Restores after each file and on exit.
#
# The `390da2d-` name is historical (the round-1 head); this is the tool, the logs
# are the per-SHA evidence. Hardened in round 2 for Greptile finding 3:
#   * refuses to run when a listed file has uncommitted edits;
#   * backs up each file and restores its exact bytes on EXIT, so a rerun can
#     never destroy local edits (`git checkout -- <f>` restored the INDEX, not the
#     original file, and `git diff "$BASE" -- "$f"` folded the edits into the
#     reversed patch);
#   * mktemp for the patch, so two lanes cannot clobber one /tmp/mut.patch;
#   * fails loudly if the reverse patch does not apply.
#
# Never `git stash` here: `git stash push -- <path>` with nothing to stash pops an
# unrelated stash (`.agents/wisdom/2026-10-14-git-stash-pathspec-pops-unrelated-stash.md`).
set -u
cd "$(dirname "$0")/../../.." || exit 1
BASE="${1:-7f8f5c2}"
FILES=(
  apps/web/src/lib/numeric-input.ts
  apps/web/src/lib/supplier-opening-draft.ts
  apps/web/src/components/parties/supplier-return-draft.ts
  apps/web/src/components/parties/supplier-return-panel.tsx
  apps/web/src/components/ui/amount-percentage-input.tsx
  apps/web/src/pages/invoice.tsx
  apps/web/src/pages/items.tsx
  apps/web/src/pages/stock.tsx
  apps/web/src/components/parties/customer-settle-panel.tsx
  apps/web/src/components/parties/supplier-pay-panel.tsx
  apps/web/src/components/parties/supplier-adjust-panel.tsx
)

git rev-parse --verify --quiet "$BASE" > /dev/null || {
  echo "REFUSING: BASE '$BASE' is not a commit in this repo"
  exit 1
}

# Refuse a dirty listed file: the proof mutates these files by reverse-applying a
# commit-range diff, which is only meaningful from the committed state.
dirty=0
for f in "${FILES[@]}"; do
  if [ -n "$(git status --porcelain -- "$f")" ]; then
    echo "REFUSING: $f has uncommitted changes; the proof would clobber them"
    dirty=1
  fi
done
[ "$dirty" -eq 0 ] || exit 1

BACKUP_DIR="$(mktemp -d)"
PATCH="$(mktemp)"
OUT="$(mktemp)"
restore() {
  for i in "${!FILES[@]}"; do
    if [ -f "$BACKUP_DIR/$i" ]; then
      cp -p "$BACKUP_DIR/$i" "${FILES[$i]}"
    fi
  done
  rm -rf "$BACKUP_DIR" "$PATCH" "$OUT"
}
trap restore EXIT

for i in "${!FILES[@]}"; do
  cp -p "${FILES[$i]}" "$BACKUP_DIR/$i" || {
    echo "FATAL: could not back up ${FILES[$i]}"
    exit 1
  }
done

status=0
for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  echo "=================== MUTATION: revert $f ==================="
  git diff "$BASE" -- "$f" > "$PATCH"
  if ! git apply -R "$PATCH"; then
    echo "FATAL: reverse patch did not apply to $f"
    exit 1
  fi
  ( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > "$OUT" 2>&1 )
  code=$?
  echo "ratchet exit code: $code"
  grep -E '^\+   "|\(fail\)|has every converted gate absent|classifies every detected gate' "$OUT" | head -25
  cp -p "$BACKUP_DIR/$i" "$f"
  if [ "$code" -eq 0 ]; then
    echo "PROBLEM: the ratchet stayed green on a reverted raw gate"
    status=1
  fi
done

leftover="$(git status --porcelain -- "${FILES[@]}")"
if [ -n "$leftover" ]; then
  echo "PROBLEM: restored tree still differs from the index:"
  echo "$leftover"
  status=1
fi

echo "=================== ALL FILES RESTORED ==================="
git status --short -- "${FILES[@]}"
exit "$status"
