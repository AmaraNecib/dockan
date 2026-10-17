#!/usr/bin/env bash
# #244 round 2, Greptile finding 3 — failing-first demonstration for the
# mutation-proof script's guard.
#
# Runs the UNFIXED script (from `git show HEAD:...`) and the FIXED script against
# throwaway repos, so the real worktree is never the subject:
#
#   A. unfixed + a dirty listed file  -> the local edit is DESTROYED (the finding)
#   B. fixed   + a dirty listed file  -> refuses (exit 1), edit byte-preserved
#   C. fixed   + a clean tree         -> mutates, reddens, restores exact bytes
#
# Usage: bash .scratch/reviews/244/mutation-proof-guard-demo.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="$SCRIPT_DIR/390da2d-mutation-proof.sh"
OLD_SCRIPT_SHA="5fbe0f0"
OLD_SCRIPT_REL=".scratch/reviews/244/390da2d-mutation-proof.sh"
TMP="$(mktemp -d)"
FAILURES=0

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
SUBJECT="apps/web/src/lib/numeric-input.ts"
MARKER="// LOCAL EDIT THAT MUST SURVIVE"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

setup_repo() {
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo/.scratch/reviews/244"
  cd "$TMP/repo" || exit 1
  git init -q .
  git config user.email demo@example.com
  git config user.name demo
  git config commit.gpgsign false
  for f in "${FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    printf 'const gate = (draft: string) => (draft.trim() === "" ? null : draft);\n' > "$f"
  done
  mkdir -p apps/web/src/lib
  cat > apps/web/src/lib/blankness-ratchet.test.ts <<'RATCHET'
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

test("has every converted gate absent, so reverting one reddens this ratchet", () => {
  const offenders = walk(root).filter((path) => readFileSync(path, "utf8").includes('draft.trim() === ""'));
  expect(offenders).toEqual([]);
});
RATCHET
  git add -A
  git commit -qm "raw form (pre-conversion base)"
  BASE="$(git rev-parse HEAD)"
  for f in "${FILES[@]}"; do
    printf 'const gate = (draft: string) => (draftBlank(draft) ? null : draft);\n' > "$f"
  done
  git add -A
  git commit -qm "converted form (head)"
  printf '%s\n' "$MARKER" >> "$SUBJECT"
  BEFORE="$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
}

echo "########## CASE A — UNFIXED script, dirty listed file ##########"
setup_repo
cd "$ROOT" || exit 1
git show "$OLD_SCRIPT_SHA:$OLD_SCRIPT_REL" > "$TMP/repo/$OLD_SCRIPT_REL"
cd "$TMP/repo" || exit 1
bash "$OLD_SCRIPT_REL" "$BASE" > "$TMP/case-a.out" 2>&1
echo "old script exit code: $?"
tail -6 "$TMP/case-a.out"
if grep -q "$MARKER" "$SUBJECT"; then
  echo "CASE A: local edit SURVIVED (unexpected — the finding did not reproduce)"
  FAILURES=$((FAILURES + 1))
else
  echo "CASE A: local edit DESTROYED — the finding reproduces on the unfixed script"
fi

echo
echo "########## CASE B — FIXED script, dirty listed file ##########"
setup_repo
cp -p "$SCRIPT" "$TMP/repo/$OLD_SCRIPT_REL"
cd "$TMP/repo" || exit 1
bash "$OLD_SCRIPT_REL" "$BASE" > "$TMP/case-b.out" 2>&1
code=$?
echo "fixed script exit code: $code"
tail -3 "$TMP/case-b.out"
AFTER="$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
if [ "$code" -eq 1 ] && grep -q "$MARKER" "$SUBJECT" && [ "$BEFORE" = "$AFTER" ]; then
  echo "CASE B: refused before mutating; edit byte-identical"
else
  echo "CASE B: FAILED (code=$code, marker=$([ -f "$SUBJECT" ] && grep -c "$MARKER" "$SUBJECT") bytes=$BEFORE->$AFTER)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE C — FIXED script, clean tree ##########"
setup_repo
# Drop the local edit Case A/B appended: this case needs a clean listed file.
git checkout -q -- "$SUBJECT"
cp -p "$SCRIPT" "$TMP/repo/$OLD_SCRIPT_REL"
CLEAN_BEFORE="$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
cd "$TMP/repo" || exit 1
bash "$OLD_SCRIPT_REL" "$BASE" > "$TMP/case-c.out" 2>&1
code=$?
echo "fixed script exit code: $code"
grep -E 'MUTATION: revert|ratchet exit code|\(fail\)|\(pass\) the converted|ALL FILES RESTORED|PROBLEM' "$TMP/case-c.out" | grep -vE '^\+ ' | head -40
CLEAN_AFTER="$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
LEFTOVER="$(git status --porcelain -- "${FILES[@]}")"
printf 'CASE C leftover raw: <%s>\n' "$LEFTOVER"
if [ "$code" -eq 0 ] && [ "$CLEAN_BEFORE" = "$CLEAN_AFTER" ] && [ -z "$LEFTOVER" ] \
  && grep -q "(fail) has every converted gate absent" "$TMP/case-c.out"; then
  echo "CASE C: every file reverted, the ratchet REDDENED on every revert, and the tree was restored byte-identical"
else
  echo "CASE C: FAILED (code=$code, bytes=$CLEAN_BEFORE->$CLEAN_AFTER, leftover='$LEFTOVER')"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## RESULT ##########"
if [ "$FAILURES" -eq 0 ]; then
  echo "guard demo PASSED (1 demonstrated bug, 2 required behaviours)"
else
  echo "guard demo FAILED in $FAILURES case(s)"
fi
exit "$FAILURES"
