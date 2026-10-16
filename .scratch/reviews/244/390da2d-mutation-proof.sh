#!/usr/bin/env bash
# #244 mutation proof: revert each converted source file to its raw-.trim() form
# (HEAD vs HEAD~1), run the ratchet, and capture the failure. Restores after each.
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
for f in "${FILES[@]}"; do
  echo "=================== MUTATION: revert $f ==================="
  git diff "$BASE" -- "$f" > /tmp/mut.patch
  git apply -R /tmp/mut.patch
  ( cd apps/web && bun test src/lib/blankness-ratchet.test.ts > /tmp/mut.out 2>&1 )
  code=$?
  echo "ratchet exit code: $code"
  grep -E '^\+   "|\(fail\)|has every converted gate absent|classifies every detected gate' /tmp/mut.out | head -25
  git checkout -- "$f"
done
echo "=================== ALL FILES RESTORED ==================="
git status --short
