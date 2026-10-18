#!/usr/bin/env bash
# #244 round 3, Greptile finding 3 (the other half) — a NON-ZERO test exit is not a
# detection. Failing-first demonstration for both proof harnesses.
#
#   A. OLD mutation-proof + runner error (ratchet file missing) -> exits 0, "proved" nothing
#   B. NEW mutation-proof + runner error                        -> refuses at the baseline
#   C. NEW mutation-proof + healthy runner                      -> exits 0, still detects
#   D. OLD branch-pin + a runner that CRASHES on every deletion -> reports PASSED
#   E. NEW branch-pin + the same crashing runner                -> refuses ("no failing test")
#
# The old scripts come from the pre-round-3 head with `git show`; every repo is a
# throwaway under mktemp, so the real worktree is never the subject.
#
# Usage: bash .scratch/reviews/244/proof-baseline-guard-demo.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MUT="$SCRIPT_DIR/390da2d-mutation-proof.sh"
PIN="$SCRIPT_DIR/branch-pin-proof.sh"
OLD_SHA="92f40d0"
MUT_REL=".scratch/reviews/244/390da2d-mutation-proof.sh"
PIN_REL=".scratch/reviews/244/branch-pin-proof.sh"
TMP="$(mktemp -d)"
FAILURES=0
trap 'rm -rf "$TMP"' EXIT

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

# A temp repo whose base commit holds the raw gate in each listed file and whose
# head converts it, so `git diff BASE -- f` reverse-applies into the raw form.
setup_mutation_repo() {
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
}

# A temp repo with the ten matcher call sites and a ratchet whose module-scope
# invariant throws when one is deleted: the runner then exits non-zero with NO
# `(fail)` line — the crash shape the round-3 guard must refuse.
setup_branch_repo() {
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo/apps/web/src/tests" "$TMP/repo/apps/web/src/lib" "$TMP/repo/.scratch/reviews/244"
  cat > "$TMP/repo/apps/web/src/tests/blankness-gates.ts" <<'SCANNER'
export const found: string[] = [];
function claimInline(name: string, produce: () => string | null): void {
  const value = produce();
  if (value !== null) found.push(value);
}
const INLINE_FWD = "INLINE_FWD";
const PAREN_FWD = "PAREN_FWD";
const PAREN_REV = "PAREN_REV";
const INLINE_REV = "INLINE_REV";
const INLINE_LEN = "INLINE_LEN";
const INLINE_LEN_REV = "INLINE_LEN_REV";
const USE_FWD = "USE_FWD";
const USE_LEN_FWD = "USE_LEN_FWD";
const USE_REV = "USE_REV";
const USE_LEN_REV = "USE_LEN_REV";
  claimInline(INLINE_FWD, () => INLINE_FWD);
  claimInline(PAREN_FWD, () => PAREN_FWD);
  claimInline(PAREN_REV, () => PAREN_REV);
  claimInline(INLINE_REV, () => INLINE_REV);
  claimInline(INLINE_LEN, () => INLINE_LEN);
  claimInline(INLINE_LEN_REV, () => INLINE_LEN_REV);
  claimInline(USE_FWD, () => USE_FWD);
  claimInline(USE_LEN_FWD, () => USE_LEN_FWD);
  claimInline(USE_REV, () => USE_REV);
  claimInline(USE_LEN_REV, () => USE_LEN_REV);
SCANNER
  cat > "$TMP/repo/apps/web/src/lib/blankness-ratchet.test.ts" <<'RATCHET'
import { expect, test } from "bun:test";
import { found } from "../tests/blankness-gates";

if (found.length !== 10) throw new Error(`scanner branches wired: ${found.length}/10`);

test("scanner branches are all wired", () => {
  expect(found.length).toBe(10);
});
RATCHET
  cd "$TMP/repo" || exit 1
  git init -q .
  git config user.email demo@example.com
  git config user.name demo
  git config commit.gpgsign false
  git add -A
  git commit -qm "fake scanner + crash-on-missing-branch ratchet"
}

echo "########## CASE A — OLD mutation-proof, runner error (ratchet file missing) ##########"
setup_mutation_repo
rm -f apps/web/src/lib/blankness-ratchet.test.ts
cd "$ROOT" || exit 1
git show "$OLD_SHA:$MUT_REL" > "$TMP/repo/$MUT_REL"
cd "$TMP/repo" || exit 1
bash "$MUT_REL" "$BASE" > "$TMP/case-a.out" 2>&1
code=$?
echo "old script exit code: $code"
grep -E 'MUTATION: revert apps/web/src/lib/numeric-input|ratchet exit code|did not match any test files|ALL FILES RESTORED' "$TMP/case-a.out" | head -6
if [ "$code" -eq 0 ]; then
  echo "CASE A: the unfixed script exits 0 although the runner never ran a test — a proof that proves nothing"
else
  echo "CASE A: FAILED (expected a false pass, got exit $code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE B — NEW mutation-proof, runner error ##########"
setup_mutation_repo
rm -f apps/web/src/lib/blankness-ratchet.test.ts
cp -p "$MUT" "$TMP/repo/$MUT_REL"
cd "$TMP/repo" || exit 1
bash "$MUT_REL" "$BASE" > "$TMP/case-b.out" 2>&1
code=$?
echo "fixed script exit code: $code"
grep -E 'baseline ratchet exit code|FATAL' "$TMP/case-b.out" | head -3
if [ "$code" -eq 1 ] \
  && grep -q 'baseline ratchet exit code: 1' "$TMP/case-b.out" \
  && grep -q 'FATAL: the ratchet is not green before any mutation' "$TMP/case-b.out"; then
  echo "CASE B: refused at the baseline; the runner error is no longer a detection"
else
  echo "CASE B: FAILED (code=$code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE C — NEW mutation-proof, healthy runner ##########"
setup_mutation_repo
cp -p "$MUT" "$TMP/repo/$MUT_REL"
cd "$TMP/repo" || exit 1
bash "$MUT_REL" "$BASE" > "$TMP/case-c.out" 2>&1
code=$?
echo "fixed script exit code: $code"
grep -E 'baseline ratchet exit code|MUTATION: revert|ratchet exit code|ALL FILES RESTORED' "$TMP/case-c.out" | head -8
reverts="$(grep -cE '\(fail\).*has every converted gate absent' "$TMP/case-c.out" || true)"
echo "expected-assertion failures observed: $reverts (>= ${#FILES[@]} required)"
if [ "$code" -eq 0 ] && [ "$reverts" -ge "${#FILES[@]}" ]; then
  echo "CASE C: baseline green, every revert reddened on the expected assertion, tree restored"
else
  echo "CASE C: FAILED (code=$code, expected-assertion failures=$reverts)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE D — OLD branch-pin, runner crashes on every deletion ##########"
setup_branch_repo
cd "$ROOT" || exit 1
git show "$OLD_SHA:$PIN_REL" > "$TMP/repo/$PIN_REL"
cd "$TMP/repo" || exit 1
bash "$PIN_REL" > "$TMP/case-d.out" 2>&1
code=$?
echo "old branch-pin exit code: $code"
grep -E 'delete INLINE_FWD|branch-pin proof|restored ratchet exit|PROBLEM' "$TMP/case-d.out" | head -6
if [ "$code" -eq 0 ] && grep -q 'branch-pin proof PASSED' "$TMP/case-d.out"; then
  echo "CASE D: the unfixed script reports all 10 branches pinned although no deletion produced a failing test"
else
  echo "CASE D: FAILED (code=$code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## CASE E — NEW branch-pin, runner crashes on every deletion ##########"
setup_branch_repo
cp -p "$PIN" "$TMP/repo/$PIN_REL"
cd "$TMP/repo" || exit 1
bash "$PIN_REL" > "$TMP/case-e.out" 2>&1
code=$?
echo "fixed branch-pin exit code: $code"
grep -E 'baseline ratchet exit code|delete INLINE_FWD|PROBLEM|branch-pin proof' "$TMP/case-e.out" | head -6
if [ "$code" -eq 1 ] && grep -q 'NO failing test' "$TMP/case-e.out"; then
  echo "CASE E: refused — a crash with no failing test is not a pinned branch"
else
  echo "CASE E: FAILED (code=$code)"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "########## RESULT ##########"
if [ "$FAILURES" -eq 0 ]; then
  echo "baseline-guard demo PASSED (2 demonstrated false passes, 3 required behaviours)"
else
  echo "baseline-guard demo FAILED in $FAILURES case(s)"
fi
exit "$FAILURES"
