#!/usr/bin/env bash
# crew-clean.sh — burn worktrees whose work is already merged and which no lane holds.
#
#   crew-clean.sh            # burn everything unused (keeps the main repo)
#   crew-clean.sh --keep a b # never touch these worktree names
#   crew-clean.sh --dry-run  # say what would go and how much it frees
#
# WHY THIS EXISTS: closing a lane after its PR merges used to leave the checkout
# behind, and sixteen of them quietly reached 2.9 GB. Freeing disk cannot depend on
# someone remembering -- it is the last step of "merged and closed", so it is a
# command with a rule rather than a habit.
#
# SAFETY, in order, because this is destructive:
#   1. the main repo is never touched;
#   2. a worktree with a running lane (a herdr workspace label matching its name) is
#      skipped -- never burn a checkout an agent is working in;
#   3. uncommitted files OUTSIDE .scratch/ are reported and the worktree is SKIPPED,
#      unless --force. Scratch and build artifacts are disposable; source is not;
#   4. **an OPEN PR blocks the burn.** A worktree whose branch has an open pull request
#      is kept, because review findings come back and the fix happens in THAT checkout.
#      Burning it mid-review costs a re-clone for no gain. The owner's rule, verbatim:
#      "you are not allowed to burn the worktree until you merge that PR or we give up
#      on it totally."
#   4b. unpushed commits block the burn too -- the branch would keep them, but the
#      checkout is the only place someone was working;
#   5. `--keep` is honoured, for anything else worth holding;
#   5. the branch is never deleted -- it lives in the shared .git, so burned
#      checkouts stay recoverable with `git worktree add`.
set -u

REPO="D:/projects/mani-project"
WT_ROOT="/d/projects/mani-worktrees"
DRY=0; FORCE=0; KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    --keep) shift; KEEP="$KEEP $1" ;;
    *) echo "usage: crew-clean.sh [--dry-run] [--force] [--keep NAME...]" >&2; exit 2 ;;
  esac
  shift
done

lanes="$(herdr workspace list 2>/dev/null | python -c "
import json,sys
try:
    for w in json.load(sys.stdin)['result']['workspaces']:
        print(w.get('label') or '')
except Exception:
    pass
" 2>/dev/null)"

before="$(du -sm "$WT_ROOT" 2>/dev/null | cut -f1)"
burned=0; kept=0; skipped=0

for p in $(git -C "$REPO" worktree list | awk 'NR>1{print $1}'); do
  name="$(basename "$p")"
  case " $KEEP " in *" $name "*) echo "  keep   $name (--keep)"; kept=$((kept+1)); continue ;; esac
  if printf '%s\n' "$lanes" | grep -qx "$name"; then
    echo "  skip   $name (a lane holds it)"; skipped=$((skipped+1)); continue
  fi
  # An open PR (or unpushed commits) means this checkout is still the working surface.
  br="$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -n "$br" ] && [ "$br" != "HEAD" ]; then
    if [ "$(gh pr list --repo "${SLUG:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}" --head "$br" --state open --json number --jq 'length' 2>/dev/null || echo 0)" != "0" ]; then
      echo "  keep   $name (open PR on $br -- review fixes happen here)"; kept=$((kept+1)); continue
    fi
    if [ "$(git -C "$p" log --oneline "@{upstream}..HEAD" 2>/dev/null | wc -l)" -gt 0 ]; then
      echo "  keep   $name (unpushed commits on $br)"; kept=$((kept+1)); continue
    fi
  fi
  # Real (non-scratch) uncommitted files are the only thing a burn can lose.
  if [ "$FORCE" != "1" ]; then
    real="$(git -C "$p" status --porcelain 2>/dev/null | awk '{print $NF}' \
      | grep -vE '^\.scratch/|^\.dokan-port$|^\.e2e-data|^test-results/|^\.e2e-video' | head -3)"
    if [ -n "$real" ]; then
      echo "  SKIP   $name (uncommitted source: $(printf '%s' "$real" | tr '\n' ' '))"; skipped=$((skipped+1)); continue
    fi
  fi
  sz="$(du -sm "$p" 2>/dev/null | cut -f1)"
  if [ "$DRY" = "1" ]; then
    echo "  would burn $name (${sz} MB)"; burned=$((burned+1)); continue
  fi
  git -C "$REPO" worktree remove --force "$p" >/dev/null 2>&1
  [ -d "$p" ] && cmd //c "rmdir /s /q $(cygpath -w "$p" 2>/dev/null || echo "$p")" >/dev/null 2>&1
  if [ -d "$p" ]; then echo "  STUCK  $name (could not remove)"; skipped=$((skipped+1)); continue; fi
  echo "  burned $name (${sz} MB)"; burned=$((burned+1))
done

git -C "$REPO" worktree prune >/dev/null 2>&1
after="$(du -sm "$WT_ROOT" 2>/dev/null | cut -f1)"
echo
echo "  burned=$burned kept=$kept skipped=$skipped"
[ "$DRY" = "0" ] && [ -n "$before" ] && [ -n "$after" ] && echo "  freed $(( before - after )) MB (worktrees now ${after} MB)"
echo "  branches are kept: recover any checkout with git worktree add <path> <branch>"
