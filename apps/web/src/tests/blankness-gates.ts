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
 * Round 2 (#244): every matcher runs over the WHOLE comment-stripped source and
 * claims its match span, instead of walking line by line. A comparison split
 * across two lines is therefore still one gate, and an inline gate on a line no
 * longer hides a two-step gate beside it (`if (inline) continue` is gone). A
 * declaration is visible to a comparison only when the brace pairs enclosing the
 * declaration also enclose the comparison, so a normalised declaration in an
 * inner block cannot mask an outer raw check.
 *
 * KNOWN CEILING (say it, do not imply otherwise): detection is syntactic, so a
 * gate written as a bare truthiness test (`if (!d.trim())`, `d.trim() ? a : b`),
 * a negation on a call-expression receiver (`f().trim()`), or in a file that
 * parses numerics without importing `amount-parse`/`numeric-input`, is NOT
 * caught. Scope visibility is brace-pair ancestry over `const`/`let` — `var`
 * hoisting is not modelled, and regex literals are not parsed, so an unbalanced
 * `{`/`}` inside one could shift a scope chain. Every gate of the matched forms
 * is caught; this comment is the honest boundary of that claim.
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
/**
 * The start of a two-step declaration. The right-hand side is read separately so
 * it may cross a line break (`const trimmed =\n  draft.trim();`).
 */
const DECL = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*`, "g");
const DECL_TRIM = String.raw`\.trim\(\)`;
/**
 * Anything between `=` and the `.trim()` that ends the statement means the
 * `.trim()` belongs to a later statement, not this declaration.
 */
const STATEMENT_BREAK = /[;}]|\n\s*(?:const|let|var|return|if|for|while|switch|function|export|import|throw|case|break|continue)\b/;
const USE_FWD = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*)\s*(===|!==|==|!=)\s*(""|'')`,
  "g",
);
const USE_REV = new RegExp(
  String.raw`(""|'')\s*(===|!==|==|!=)\s*([A-Za-z_$][\w$]*)\b`,
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

interface Span {
  readonly start: number;
  readonly end: number;
}

interface BracePair {
  readonly open: number;
  readonly close: number;
}

interface Declaration {
  readonly name: string;
  /** The expression the `.trim()` was called on, e.g. `draft` or
   * `normalizeArabicIndicDigits(draft)`, collapsed to one line. */
  readonly rhs: string;
  readonly offset: number;
  readonly enclosing: readonly BracePair[];
}

/** The 1-based line a character offset sits on. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** Matched brace pairs, ignoring braces inside string and template literals. */
function bracePairs(text: string): BracePair[] {
  const stack: number[] = [];
  const pairs: BracePair[] = [];
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "{") stack.push(i);
    else if (char === "}") {
      const open = stack.pop();
      if (open !== undefined) pairs.push({ open, close: i });
    }
  }
  return pairs;
}

/** The brace pairs enclosing one offset — the scope chain of a token. */
function enclosing(pairs: readonly BracePair[], offset: number): BracePair[] {
  return pairs.filter((pair) => pair.open < offset && offset < pair.close);
}

/**
 * Every `const`/`let X = <expr>.trim()` in the text, with its scope chain. The
 * right-hand side may cross line breaks; a statement break before the `.trim()`
 * means the `.trim()` is not this declaration's.
 */
function collectDeclarations(text: string, braces: readonly BracePair[]): Declaration[] {
  const trimCalls: number[] = [];
  for (const match of text.matchAll(new RegExp(DECL_TRIM, "g"))) trimCalls.push(match.index);
  const declarations: Declaration[] = [];
  for (const match of text.matchAll(DECL)) {
    const offset = match.index;
    const afterEquals = offset + match[0].length;
    const trimOffset = trimCalls.find((candidate) => candidate >= afterEquals);
    if (trimOffset === undefined) continue;
    const rhsRegion = text.slice(afterEquals, trimOffset);
    if (STATEMENT_BREAK.test(rhsRegion)) continue;
    declarations.push({
      name: match[1]!,
      rhs: collapse(rhsRegion),
      offset,
      enclosing: enclosing(braces, offset),
    });
  }
  return declarations;
}

/**
 * The innermost declaration of `name` that is visible at `offset`: earlier in the
 * file, and whose scope chain is a prefix of the comparison's. A declaration in a
 * nested block therefore cannot mask an outer one of the same name (#244 round 2,
 * finding 2).
 */
function visibleDeclaration(
  declarations: readonly Declaration[],
  name: string,
  offset: number,
  comparisonScope: readonly BracePair[],
): Declaration | undefined {
  let found: Declaration | undefined;
  for (const declaration of declarations) {
    if (declaration.name !== name || declaration.offset >= offset) continue;
    const visible = declaration.enclosing.every((pair) =>
      comparisonScope.some((scope) => scope.open === pair.open),
    );
    if (visible) found = declaration;
  }
  return found;
}

/** Every raw-`.trim()` blankness gate in one source string. */
export function findBlanknessGates(source: string, file: string): BlanknessGate[] {
  const text = stripComments(source);
  const braces = bracePairs(text);
  const declarations = collectDeclarations(text, braces);

  const bySignature = new Map<string, { offset: number; gate: BlanknessGate }>();
  const claimed: Span[] = [];
  const overlaps = (span: Span) =>
    claimed.some((existing) => span.start < existing.end && existing.start < span.end);
  const record = (offset: number, canonical: string) => {
    const signature = `${file}::${canonical}`;
    if (bySignature.has(signature)) return;
    bySignature.set(signature, { offset, gate: { file, line: lineAt(text, offset), signature } });
  };

  // Inline forms first: they are the more specific match, and claiming their span
  // stops a broader matcher reading a two-step gate out of their middle.
  const claimInline = (regex: RegExp, receiverGroup: number, canonical: (match: RegExpExecArray) => string) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const span = { start, end: start + match[0].length };
      if (overlaps(span)) continue;
      claimed.push(span);
      if (NORMALISED.test(match[receiverGroup] ?? "")) continue;
      record(start, canonical(match));
    }
  };

  claimInline(INLINE_FWD, 1, (match) => `${collapse(match[1]!)}.trim() ${match[2]} ""`);
  claimInline(
    PAREN_FWD,
    1,
    (match) => `(${collapse(match[1]!)} ?? "").trim() ${match[3]} ""`,
  );
  claimInline(INLINE_REV, 3, (match) => `"" ${match[2]} ${collapse(match[3]!)}.trim()`);
  claimInline(INLINE_LEN, 1, (match) => `${collapse(match[1]!)}.trim().length ${match[2]} 0`);

  // Two-step: `const X = <expr>.trim(); … X === ""`, in either operand order.
  const claimTwoStep = (regex: RegExp, reversed: boolean) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const span = { start, end: start + match[0].length };
      if (overlaps(span)) continue;
      const name = (reversed ? match[3] : match[1]) ?? "";
      const operator = match[2] ?? "";
      const declaration = visibleDeclaration(declarations, name, start, enclosing(braces, start));
      if (declaration === undefined || NORMALISED.test(declaration.rhs)) continue;
      claimed.push(span);
      const suffix = `[${declaration.rhs}.trim()]`;
      record(start, reversed ? `"" ${operator} ${name} ${suffix}` : `${name} ${operator} "" ${suffix}`);
    }
  };

  claimTwoStep(USE_FWD, false);
  claimTwoStep(USE_REV, true);

  return [...bySignature.values()].sort((a, b) => a.offset - b.offset).map((entry) => entry.gate);
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
