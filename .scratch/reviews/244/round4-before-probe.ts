// #244 round 4 — the failing-first probe for findings 1-3.
//
// Run against the PRE-FIX scanner and the fixed one, from the repo root:
//   git show 1af565f:apps/web/src/tests/blankness-gates.ts > apps/web/src/tests/blankness-gates.ts
//   bun run .scratch/reviews/244/round4-before-probe.ts   # -> all three "[] (ESCAPES)"
//   git checkout -- apps/web/src/tests/blankness-gates.ts
//
// Copied here so the "escaping before" half of the evidence is reproducible
// (round4-before.log and <sha>-ratchet-first-red.log are the recorded runs).
import { findBlanknessGates } from "../../../apps/web/src/tests/blankness-gates";

const cases: Array<[string, string]> = [
  [
    "appended draft escapes (finding 1)",
    ['export function f(prefix: string, draft: string) {', '  const trimmed = normalizeArabicIndicDigits(prefix).concat(draft).trim();', '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
  [
    "block comment joins tokens (finding 2)",
    ["export function f(draft: string) {", "  const/* note */trimmed = draft.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
  [
    "nested template mis-scopes (finding 3)",
    ["export function f(draft: string, flag: boolean) {", "  const trimmed = `${flag ? `;` : draft}`.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
];
for (const [name, source] of cases) {
  const gates = findBlanknessGates(source, "s.ts").map((gate) => gate.signature);
  console.log(`${name.padEnd(40)} => ${gates.length === 0 ? "[] (ESCAPES)" : gates.join(" | ")}`);
}
