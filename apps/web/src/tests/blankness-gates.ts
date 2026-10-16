import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #244 — the scanner behind the raw-`.trim()` blankness ratchet.
 *
 * It finds every *raw* `.trim()` blankness gate in one source string: `X.trim()`
 * (or `X?.trim()`) compared to `""` (either operand order), `X.trim().length`
 * compared to `0`, and the two-step `const X = <expr>.trim(); … X === ""`. A
 * receiver already normalised through `normalizeArabicIndicDigits` (or
 * `draftBlank`) is skipped — those readers need the normalised string, so they
 * are not the defect class.
 *
 * The gate's identity is `file::<canonical text>`, not a line number: lines drift
 * with every edit, the gate's own text does not. `?.trim()` canonicalises to
 * `.trim()`; two identical gate texts in one file collapse to one signature.
 *
 * KNOWN CEILING (say it, do not imply otherwise): detection is syntactic, so a
 * gate written as a bare truthiness test (`if (!d.trim())`, `d.trim() ? a : b`),
 * a negation on a call-expression receiver (`f().trim()`), or in a file that
 * parses numerics without importing `amount-parse`/`numeric-input`, is NOT
 * caught. Every gate of the matched forms is caught; this comment is the honest
 * boundary of that claim.
 */

export const srcRoot = fileURLToPath(new URL("../", import.meta.url));

/** A member/chain receiver, e.g. `value.amount`, `drafts[line.id]`. */
const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\]))*`;
const INLINE_FWD = new RegExp(String.raw`(${CHAIN})\??\.trim\(\)\s*(===|!==|==|!=)\s*(""|'')`, "g");
const INLINE_REV = new RegExp(String.raw`(""|'')\s*(===|!==|==|!=)\s*(${CHAIN})\??\.trim\(\)`, "g");
const PAREN_FWD = new RegExp(
  String.raw`\(\s*(${CHAIN})\s*\?\?\s*(""|'')\s*\)\??\.trim\(\)\s*(===|!==|==|!=)\s*(""|'')`,
  "g",
);
const INLINE_LEN = new RegExp(String.raw`(${CHAIN})\??\.trim\(\)\.length\s*(===|!==|==|!=)\s*0`, "g");
const DECL = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*?)\.trim\(\)`, "g");
const USE = new RegExp(
  String.raw`(?:""|'')\s*(===|!==|==|!=)\s*([A-Za-z_$][\w$]*)` +
    String.raw`|\b([A-Za-z_$][\w$]*)\s*(===|!==|==|!=)\s*(?:""|'')`,
  "g",
);
/** A receiver already put through the one normaliser is not a RAW trim. */
const NORMALISED = /normalizeArabicIndicDigits|draftBlank/;

export interface BlanknessGate {
  readonly file: string;
  readonly line: number;
  /** `file::<canonical gate text>` — stable across line drift. */
  readonly signature: string;
}

/** Remove comments (block + line) but keep every newline, so line numbers hold. */
function stripComments(source: string): string {
  let out = "";
  let state: "line" | "block" | "sq" | "dq" | "tpl" | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (char === "\n") {
        state = null;
        out += char;
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = null;
        i += 1;
      } else if (char === "\n") {
        out += "\n";
      }
      continue;
    }
    if (state === "sq" || state === "dq" || state === "tpl") {
      out += char;
      const terminator = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === terminator) {
        state = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line";
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      i += 1;
      continue;
    }
    if (char === "'") state = "sq";
    else if (char === '"') state = "dq";
    else if (char === "`") state = "tpl";
    out += char;
  }
  return out;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every raw-`.trim()` blankness gate in one source string. */
export function findBlanknessGates(source: string, file: string): BlanknessGate[] {
  const lines = stripComments(source).split("\n");
  const declarations: Array<{ name: string; rhs: string; index: number }> = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(DECL)) {
      declarations.push({ name: match[1]!, rhs: collapse(match[2]!), index });
    }
  }

  const gates = new Map<string, BlanknessGate>();
  const add = (line: number, canonical: string) => {
    const signature = `${file}::${canonical}`;
    if (!gates.has(signature)) gates.set(signature, { file, line: line + 1, signature });
  };

  for (const [index, line] of lines.entries()) {
    let inline = false;
    for (const match of line.matchAll(INLINE_FWD)) {
      inline = true;
      if (NORMALISED.test(match[1]!)) continue;
      add(index, `${collapse(match[1]!)}.trim() ${match[2]} ""`);
    }
    for (const match of line.matchAll(PAREN_FWD)) {
      inline = true;
      if (NORMALISED.test(match[1]!)) continue;
      add(index, `(${collapse(match[1]!)} ?? "").trim() ${match[3]} ""`);
    }
    for (const match of line.matchAll(INLINE_REV)) {
      inline = true;
      if (NORMALISED.test(match[3]!)) continue;
      add(index, `"" ${match[2]} ${collapse(match[3]!)}.trim()`);
    }
    for (const match of line.matchAll(INLINE_LEN)) {
      inline = true;
      if (NORMALISED.test(match[1]!)) continue;
      add(index, `${collapse(match[1]!)}.trim().length ${match[2]} 0`);
    }
    // A two-step gate reuses a variable declared from a raw `.trim()` earlier in
    // the file. Skip lines that are an inline gate so the operand is not counted
    // twice.
    if (inline) continue;
    for (const match of line.matchAll(USE)) {
      const name = match[2] ?? match[3];
      const operator = match[1] ?? match[4];
      if (name === undefined || operator === undefined) continue;
      let declaration: { name: string; rhs: string; index: number } | undefined;
      for (const candidate of declarations) {
        if (candidate.name === name && candidate.index <= index) declaration = candidate;
      }
      if (declaration === undefined || NORMALISED.test(declaration.rhs)) continue;
      add(index, `${name} ${operator} "" [${declaration.rhs}.trim()]`);
    }
  }
  return [...gates.values()];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * The ratchet's scope: every non-test source file that reads numerics through the
 * shared readers (`amount-parse` / `numeric-input`), plus the reader modules
 * themselves. A new numeric reader imports a reader, so it is scanned with no
 * test edit.
 */
export function numericReaderFiles(): string[] {
  const all = walk(srcRoot).filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));
  const readers = ["lib/amount-parse.ts", "lib/numeric-input.ts"].map((path) => join(srcRoot, path));
  const imported = all.filter((path) =>
    /from\s+["'][^"']*\/(amount-parse|numeric-input)["']/.test(readFileSync(path, "utf8")),
  );
  const selected = new Set([...readers, ...imported]);
  return [...selected].map((path) => relative(srcRoot, path).split("\\").join("/")).sort();
}

/** Every gate in the scope, ready for the classifier. */
export function scanNumericDraftReaders(): BlanknessGate[] {
  return numericReaderFiles().flatMap((file) =>
    findBlanknessGates(readFileSync(join(srcRoot, file), "utf8"), file),
  );
}
