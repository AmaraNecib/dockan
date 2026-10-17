/**
 * #249 — observed scanner behaviour per shape, run against whichever scanner is
 * in the working tree. Run before the AST walk (records the regex escapes) and
 * after (records what the walk catches / refuses).
 *
 * Usage (from the repo root):  bun run .scratch/reviews/249/scanner-shapes-249.ts
 */
import { findBlanknessGates } from "../../../apps/web/src/tests/blankness-gates";

const cases: Array<[string, string]> = [
  // brief: comments in any position
  ["comment inside the chain", 'const t = draft./* c */trim();\nconst b = t === "";'],
  ["comment joining tokens", "const/* c */t = draft.trim();\nconst b = t === \"\";"],
  ["comment before .trim (inline)", 'const b = draft./* c */trim() === "";'],
  // brief: regex literals containing a quote or /*
  ["regex literal with a quote", 'const re = /"/;\nconst b = draft.trim() === "";'],
  ["regex literal with /*", 'const re = /[/*]/;\nconst t = draft.trim();\nif (t === "") return;'],
  ["regex literal with //", 'const re = /[//]/; const b = draft.trim() === "";'],
  ["regex literal with a backtick", 'const re = /[`]/;\nconst b = draft.trim() === "";'],
  // brief: string/template TEXT vs ${}
  ["gate text inside a single-quoted string", "const s = 'draft.trim() === \"\"';\nvoid s;"],
  ["gate text inside template text", "const s = `draft.trim() === \"\"`;\nvoid s;"],
  ["gate inside an interpolation", 'const b = `${draft.trim() === ""}`;'],
  ["nested template", "const t = `${flag ? `;` : draft}`.trim();\nconst b = t === \"\";"],
  // brief: non-ASCII identifier binding
  ["non-ASCII binding", 'const dé = draft.trim();\nconst b = dé === "";'],
  // brief: appended calls
  [
    "appended normalised prefix",
    'const t = normalizeArabicIndicDigits(prefix).concat(draft).trim();\nconst b = t === "";',
  ],
  ["appended normaliser inline", 'const b = normalizeArabicIndicDigits(prefix).concat(draft).trim() === "";'],
  // brief: scope
  [
    "inner normalised block masks outer",
    'const t = draft.trim();\n{\n  const t = normalizeArabicIndicDigits(draft).trim();\n  void t;\n}\nif (t === "") return;',
  ],
  // base ceilings the walk may now handle
  ["call receiver inline", 'const b = f().trim() === "";'],
  ["as-asserted receiver", 'const b = (draft as string).trim() === "";'],
  ["parenthesised receiver", 'const b = (draft).trim() === "";'],
  ["non-null receiver", 'const b = draft!.trim() === "";'],
  ["double trim", 'const b = draft.trim().trim() === "";'],
  ["var binding", 'var t = draft.trim();\nconst b = t === "";'],
  ["second declarator", 'const t = draft.trim(), u = e.trim();\nconst b = t === "" || u === "";'],
  // fail-closed targets (must be a loud refusal, never [])
  ["truthiness test", "if (!draft.trim()) return;"],
  ["relational length", "const b = draft.trim().length > 0;"],
  ["empty-template operand", "const b = draft.trim() === ``;"],
  // precision: shapes that are NOT gates and must stay []
  ["normaliser predicate", 'const b = normalizeArabicIndicDigits(draft).trim() === "";'],
  ["normalised key, raw value", 'const b = drafts[normalizeArabicIndicDigits(id)].trim() === "";'],
  ["receiver named draftBlankish", 'const draftBlankish = draft.trim();\nconst b = draftBlankish.trim() === "";'],
  ["comparison against a non-blank", "const b = current.name.trim() === current.baseline.name;"],
  ["trim used as an argument", "setDebounced(query.trim());"],
];

for (const [name, source] of cases) {
  let rendered: string;
  try {
    const gates = findBlanknessGates(source, "s.ts").map((gate) => `${gate.signature} @L${gate.line}`);
    rendered = gates.length === 0 ? "[]" : gates.join(" | ");
  } catch (error) {
    rendered = `THROWS: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.log(`${name.padEnd(34)} => ${rendered}`);
}
