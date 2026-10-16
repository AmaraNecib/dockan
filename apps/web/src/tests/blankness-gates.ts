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
 * across two lines is therefore still one gate, in either operand order, for
 * `.length` too, and for a `.trim()` chain the formatter breaks mid-chain, and an
 * inline gate on a line no longer hides a two-step gate beside it (`if (inline)
 * continue` is gone). A declaration is visible to a comparison only when the
 * brace pairs enclosing the declaration also enclose the comparison, so a
 * normalised declaration in an inner block cannot mask an outer raw check, and a
 * property read (`other.trimmed === ""`) is not attributed to a local `trimmed`.
 * A two-step declaration counts as normalised only when its right-hand side CALLS
 * the normaliser, so a receiver whose name merely contains `draftBlank` is still a
 * raw gate. The right-hand side may cross lines and bracketed groups (an object
 * argument, a template `${}`); only a `;`, a closing bracket at depth 0 or a new
 * statement ends it.
 *
 * KNOWN CEILING (say it, do not imply otherwise): detection is syntactic, so a
 * gate written as a bare truthiness test (`if (!d.trim())`, `d.trim() ? a : b`),
 * a relational `.length` test (`d.trim().length > 0`, `> 0` and `>= 1` alike), a
 * receiver that is NOT a plain member chain (`f().trim() === ""`,
 * `(draft as string).trim()`, `(draft).trim()`, `draft!.trim()`,
 * `drafts[\n id\n].trim()`, `x.trimStart() === ""`; the two-step form
 * `const t = f().trim()` IS caught), a blank operand that is not a `""`/`''`
 * literal (an empty template), a value assigned after a bare `let t; t = d.trim()`
 * or aliased (`const u = t`), a second declarator on one line
 * (`const t = d.trim(), u = e.trim()`), a destructuring binding, a gate in a file
 * that parses numerics without importing `amount-parse`/`numeric-input` — none of
 * those is caught. A declaration bound by `var` is not seen at all (its gate is
 * missed), and a `var`, parameter or `catch` binding can be attributed to a
 * same-named visible declaration (false positive); an ASI-ambiguous
 * `const t = foo` followed by `bar.trim();` attributes that `.trim()` to `t`
 * (false positive with invented receiver text), and so does an arrow/callback
 * body on the right-hand side (`const t = xs.map((x) => x.trim())`). A string or
 * template literal whose TEXT looks like a gate is scanned as code: blanking the
 * body was rejected because it would also hide a real gate inside a template
 * `${}` expression, which is the unsafe direction for a ratchet. Regex literals
 * are not parsed, so a regex holding a quote or a `/*` can mis-scope or HIDE every
 * later gate in the file (the unsafe direction) — a deferred follow-up, not a
 * dismissal. Every gate of the matched forms is caught; this comment is the honest
 * boundary of that claim.
 */

export const srcRoot = fileURLToPath(new URL("../", import.meta.url));

/** A member/chain receiver, e.g. `value.amount`, `drafts[line.id]`. */
const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\]))*`;
const INLINE_FWD = new RegExp(String.raw`(${CHAIN})\s*\??\.trim\(\)\s*(===|!==|==|!=)\s*(""|'')`, "g");
const INLINE_REV = new RegExp(String.raw`(""|'')\s*(===|!==|==|!=)\s*(${CHAIN})\s*\??\.trim\(\)`, "g");
const PAREN_FWD = new RegExp(
  String.raw`\(\s*(${CHAIN})\s*\?\?\s*(${CHAIN}|""|'')\s*\)\s*\??\.trim\(\)\s*(===|!==|==|!=)\s*(""|'')`,
  "g",
);
const PAREN_REV = new RegExp(
  String.raw`(""|'')\s*(===|!==|==|!=)\s*\(\s*(${CHAIN})\s*\?\?\s*(${CHAIN}|""|'')\s*\)\s*\??\.trim\(\)`,
  "g",
);
const INLINE_LEN = new RegExp(String.raw`(${CHAIN})\s*\??\.trim\(\)\s*\??\.length\s*(===|!==|==|!=)\s*0`, "g");
const INLINE_LEN_REV = new RegExp(String.raw`0\s*(===|!==|==|!=)\s*(${CHAIN})\s*\??\.trim\(\)\s*\??\.length`, "g");
/**
 * The start of a two-step declaration. The right-hand side is read separately so
 * it may cross a line break (`const trimmed =\n  draft.trim();`).
 */
const DECL = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*`, "g");
const DECL_TRIM = String.raw`\.trim\(\)`;
const OPENERS = "([{";
const CLOSERS = ")]}";
const STATEMENT_KEYWORD =
  /^\s*(?:const|let|var|return|if|for|while|switch|function|export|import|throw|case|break|continue)\b/;

/**
 * Whether a statement break sits between `=` and the `.trim()` at bracket depth 0,
 * i.e. the `.trim()` belongs to a later statement. A bracketed group (an object
 * argument, a template `${}`) does NOT end the right-hand side; a `;`, a closing
 * bracket at depth 0, or a new line that opens a new statement does.
 */
function breaksStatement(text: string, from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const char = text[i]!;
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) {
      if (depth === 0) return true;
      depth -= 1;
    } else if (char === ";" && depth === 0) return true;
    else if (char === "\n" && depth === 0 && STATEMENT_KEYWORD.test(text.slice(i + 1, i + 40))) return true;
  }
  return false;
}

/**
 * Two-step gates on the `.length` of a declared raw trim: `const t = d.trim(); if
 * (t.length === 0)`. The `.length` is what makes this safe to match without also
 * catching ordinary numeric comparisons against `0`.
 */
const USE_LEN_FWD = new RegExp(
  String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*\??\.length\s*(===|!==|==|!=)\s*0`,
  "g",
);
const USE_LEN_REV = new RegExp(
  String.raw`0\s*(===|!==|==|!=)\s*([A-Za-z_$][\w$]*)\s*\??\.length`,
  "g",
);
const USE_FWD = new RegExp(
  String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(===|!==|==|!=)\s*(""|'')`,
  "g",
);
const USE_REV = new RegExp(
  String.raw`(""|'')\s*(===|!==|==|!=)\s*([A-Za-z_$][\w$]*)\b(?!\s*\.)`,
  "g",
);
/**
 * A declaration already put through the one normaliser is not a RAW trim. Matched
 * as a CALL, so a variable that merely contains the name (`draftBlankish`) is
 * still a raw gate.
 */
const NORMALISED = /\b(?:normalizeArabicIndicDigits|draftBlank)\s*\(/;

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
    if (breaksStatement(text, afterEquals, trimOffset)) continue;
    declarations.push({
      name: match[1]!,
      rhs: collapse(text.slice(afterEquals, trimOffset)),
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
  // stops a broader matcher reading a two-step gate out of their middle. A raw
  // receiver is a member chain, so it can never be a normaliser CALL — the
  // normaliser check belongs to a two-step declaration, not here.
  const claimInline = (regex: RegExp, canonical: (match: RegExpExecArray) => string) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const span = { start, end: start + match[0].length };
      if (overlaps(span)) continue;
      claimed.push(span);
      record(start, canonical(match));
    }
  };

  // A `.trim()` chain may be broken across lines by the formatter, so the chain
  // matchers allow whitespace inside it; the canonical text collapses it away.
  claimInline(INLINE_FWD, (match) => `${collapse(match[1]!)}.trim() ${match[2]} ""`);
  claimInline(
    PAREN_FWD,
    (match) => `(${collapse(match[1]!)} ?? ${collapse(match[2]!)}).trim() ${match[3]} ""`,
  );
  claimInline(
    PAREN_REV,
    (match) => `"" ${match[2]} (${collapse(match[3]!)} ?? ${collapse(match[4]!)}).trim()`,
  );
  claimInline(INLINE_REV, (match) => `"" ${match[2]} ${collapse(match[3]!)}.trim()`);
  claimInline(INLINE_LEN, (match) => `${collapse(match[1]!)}.trim().length ${match[2]} 0`);
  claimInline(INLINE_LEN_REV, (match) => `0 ${match[1]} ${collapse(match[2]!)}.trim().length`);

  // Two-step: `const X = <expr>.trim(); … X === ""` / `X.length === 0`, in either
  // operand order.
  const claimTwoStep = (
    regex: RegExp,
    nameGroup: number,
    operatorGroup: number,
    canonical: (name: string, operator: string, rhs: string) => string,
  ) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const span = { start, end: start + match[0].length };
      if (overlaps(span)) continue;
      const name = match[nameGroup] ?? "";
      const operator = match[operatorGroup] ?? "";
      const declaration = visibleDeclaration(declarations, name, start, enclosing(braces, start));
      if (declaration === undefined || NORMALISED.test(declaration.rhs)) continue;
      claimed.push(span);
      record(start, canonical(name, operator, declaration.rhs));
    }
  };

  const gateSuffix = (rhs: string) => `[${rhs}.trim()]`;
  claimTwoStep(USE_FWD, 1, 2, (name, operator, rhs) => `${name} ${operator} "" ${gateSuffix(rhs)}`);
  claimTwoStep(
    USE_LEN_FWD,
    1,
    2,
    (name, operator, rhs) => `${name}.length ${operator} 0 ${gateSuffix(rhs)}`,
  );
  claimTwoStep(USE_REV, 3, 2, (name, operator, rhs) => `"" ${operator} ${name} ${gateSuffix(rhs)}`);
  claimTwoStep(
    USE_LEN_REV,
    2,
    1,
    (name, operator, rhs) => `0 ${operator} ${name}.length ${gateSuffix(rhs)}`,
  );

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
