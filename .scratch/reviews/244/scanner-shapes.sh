#!/usr/bin/env bash
# #244 round 2 — observed scanner behaviour per attack shape.
#
# The lenses attacked the scanner with a list of shapes; this records what the
# scanner actually returns for each, so "caught" and "stated ceiling" are
# inspectable side by side instead of asserted in prose. A shape with `[]` must be
# named in the KNOWN CEILING block of `apps/web/src/tests/blankness-gates.ts`.
#
# Usage: bash .scratch/reviews/244/scanner-shapes.sh
set -u
cd "$(dirname "$0")/../../.." || exit 1
PROBE="apps/web/src/tests/__scanner-shapes.ts"

cleanup() { rm -f "$PROBE"; }
trap cleanup EXIT

cat > "$PROBE" <<'PROBE_EOF'
import { findBlanknessGates } from "./blankness-gates";

const cases: Array<[string, string]> = [
  ["chain split before .trim()", 'const a = draft\n  .trim() === "";'],
  ["chain split before .length", "const a = draft.trim()\n  .length === 0;"],
  ["inline comparison split", "const a = draft.trim()\n  === \"\";"],
  ["reversed inline", 'const a = "" === draft.trim();'],
  ["reversed .length", "const a = 0 === draft.trim().length;"],
  ["bracketed rhs (object arg)", 'const t = parse({ raw: draft }).trim();\nconst b = t === "";'],
  ["bracketed rhs (template)", 'const t = `${draft}`.trim();\nconst b = t === "";'],
  ["two-step declaration split", "const t =\n  draft.trim();\nconst b = t === \"\";"],
  ["declaration then comparison split", "const t = draft.trim();\nconst b = t\n  === \"\";"],
  ["two-step .length fwd", "const t = draft.trim();\nconst b = t.length === 0;"],
  ["two-step .length rev", "const t = draft.trim();\nconst b = 0 === t.length;"],
  ["two-step beside an inline gate", 'const t = draft.trim();\nif (name.trim() === "" || t === "") return;'],
  ["reversed two-step", 'const t = draft.trim();\nif ("" === t) return;'],
  ["inner block masks outer", 'const t = draft.trim();\n{\n  const t = normalizeArabicIndicDigits(draft).trim();\n  void t;\n}\nif (t === "") return;'],
  ["normalised two-step declaration", 'const t = normalizeArabicIndicDigits(draft).trim();\nconst b = t === "";'],
  ["receiver named draftBlankish", 'const draftBlankish = draft.trim();\nconst b = draftBlankish.trim() === "";'],
  ["property read fwd", 'const trimmed = draft.trim();\nconst b = box.trimmed === "";'],
  ["property read rev", 'const trimmed = draft.trim();\nif ("" === trimmed.suffix) return;'],
  ["comment between", 'const b = draft.trim() /* c */ === "";'],
  ["parenthesised nullish receiver", 'const b = (drafts[line.id] ?? "").trim() !== "";'],
  ["optional-chained receiver", 'const b = draft?.trim() !== "";'],
  ["inline call receiver", 'const b = f().trim() === "";'],
  ["two-step call receiver", 'const t = f().trim();\nconst b = t === "";'],
  ["truthiness", "if (!draft.trim()) return;"],
  ["relational .length", "const b = draft.trim().length > 0;"],
  ["template blank operand", "const b = draft.trim() === ``;"],
  ["var binding", 'var t = draft.trim();\nconst b = t === "";'],
  ["deferred let assignment", 'let t;\nt = draft.trim();\nconst b = t === "";'],
  ["param shadows outer raw", 'const trimmed = draft.trim();\nfunction g(trimmed: string) { return trimmed === ""; }'],
  ["ASI mis-attribution", 'const t = foo\nbar.trim();\nconst b = t === "";'],
];
for (const [name, source] of cases) {
  const gates = findBlanknessGates(source, "s.ts").map((gate) => `${gate.signature} @L${gate.line}`);
  console.log(`${name.padEnd(34)} => ${gates.length === 0 ? "[]" : gates.join(" | ")}`);
}
PROBE_EOF

( cd apps/web && bun run "src/tests/__scanner-shapes.ts" )
