#!/usr/bin/env bash
# #244 round 2 — gate-set diff.
#
# A pure-precision scanner rewrite must not change which production gates are
# detected. This scans with the reference SHA's scanner and with the working tree
# and prints ADDED / REMOVED (both must be empty).
#
# Usage: bash .scratch/reviews/244/gate-set-diff.sh [reference-sha]
set -u
cd "$(dirname "$0")/../../.." || exit 1
REF="${1:-f30581c}"
OLD="apps/web/src/tests/__gate-set-diff-old.ts"
PROBE="apps/web/src/tests/__gate-set-diff.ts"

cleanup() { rm -f "$OLD" "$PROBE"; }
trap cleanup EXIT

git rev-parse --verify --quiet "$REF" > /dev/null || {
  echo "REFUSING: '$REF' is not a commit in this repo"
  exit 1
}
git show "$REF:apps/web/src/tests/blankness-gates.ts" > "$OLD"
cat > "$PROBE" <<'PROBE_EOF'
import * as reference from "./__gate-set-diff-old";
import * as current from "./blankness-gates";

const before = reference.scanNumericDraftReaders().map((gate) => gate.signature);
const after = current.scanNumericDraftReaders().map((gate) => gate.signature);
console.log(`reference ${process.env.GATE_SET_REF ?? ""} gates: ${before.length}`);
console.log(`current gates: ${after.length}`);
console.log("ADDED", JSON.stringify(after.filter((signature) => !before.includes(signature))));
console.log("REMOVED", JSON.stringify(before.filter((signature) => !after.includes(signature))));
PROBE_EOF

( cd apps/web && GATE_SET_REF="$REF" bun run "src/tests/__gate-set-diff.ts" )
