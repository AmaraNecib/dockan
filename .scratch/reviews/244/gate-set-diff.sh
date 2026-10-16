#!/usr/bin/env bash
# #244 round 2 — gate-set diff.
#
# A pure-precision scanner rewrite must not change which production gates are
# detected. This scans with the reference SHA's scanner and with the working tree
# and prints ADDED / REMOVED (both must be empty). Round 3 hardening: it now
# ENFORCES the empty diff itself (exit 1 otherwise) and refuses a reference that
# reported no gates, so "ADDED [] / REMOVED []" cannot be read off a scan that
# silently produced nothing to compare.
#
# Usage: bash .scratch/reviews/244/gate-set-diff.sh [reference-sha]
#
# Round 4 (Greptile finding 5): the probe paths are unique PER RUN and are only
# removed when THIS invocation created them. A fixed path could overwrite a
# developer's saved probe or collide with a concurrent comparison.
set -u
cd "$(dirname "$0")/../../.." || exit 1
REF="${1:-f30581c}"
RUN="$$-$RANDOM"
OLD_MODULE="__gate-set-diff-old.$RUN"
PROBE_MODULE="__gate-set-diff.$RUN"
OLD="apps/web/src/tests/$OLD_MODULE.ts"
PROBE="apps/web/src/tests/$PROBE_MODULE.ts"

for path in "$OLD" "$PROBE"; do
  if [ -e "$path" ]; then
    echo "REFUSING: $path already exists; not overwriting it"
    exit 1
  fi
done
cleanup() { rm -f "$OLD" "$PROBE"; }
trap cleanup EXIT

git rev-parse --verify --quiet "$REF" > /dev/null || {
  echo "REFUSING: '$REF' is not a commit in this repo"
  exit 1
}
git show "$REF:apps/web/src/tests/blankness-gates.ts" > "$OLD"
cat > "$PROBE" <<'PROBE_EOF'
import * as reference from "./__GATE_SET_DIFF_OLD_MODULE__";
import * as current from "./blankness-gates";

const before = reference.scanNumericDraftReaders().map((gate) => gate.signature);
const after = current.scanNumericDraftReaders().map((gate) => gate.signature);
console.log(`reference ${process.env.GATE_SET_REF ?? ""} gates: ${before.length}`);
console.log(`current gates: ${after.length}`);
console.log("ADDED", JSON.stringify(after.filter((signature) => !before.includes(signature))));
console.log("REMOVED", JSON.stringify(before.filter((signature) => !after.includes(signature))));
PROBE_EOF
sed -i "s|__GATE_SET_DIFF_OLD_MODULE__|$OLD_MODULE|" "$PROBE"

OUT="$( cd apps/web && GATE_SET_REF="$REF" bun run "src/tests/$PROBE_MODULE.ts" )"
printf '%s\n' "$OUT"
reference_count="$(printf '%s\n' "$OUT" | sed -n 's/^reference .* gates: \([0-9][0-9]*\)$/\1/p')"
if [ -z "$reference_count" ] || [ "$reference_count" -eq 0 ]; then
  echo "PROBLEM: the reference scanner reported no gates; a diff against an empty set proves nothing"
  exit 1
fi
if ! printf '%s\n' "$OUT" | grep -q '^ADDED \[\]$'; then
  echo "PROBLEM: ADDED is not empty"
  exit 1
fi
if ! printf '%s\n' "$OUT" | grep -q '^REMOVED \[\]$'; then
  echo "PROBLEM: REMOVED is not empty"
  exit 1
fi
echo "gate-set diff at $REF is empty (ADDED [] / REMOVED [], $reference_count gates)"
