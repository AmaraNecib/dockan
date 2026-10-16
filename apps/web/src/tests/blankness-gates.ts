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
 * Round 3 (#244): a template expression `${...}` is CODE in both passes — a
 * comment inside it is stripped and a brace inside it scopes — so a gate split by
 * a comment there is caught and an inner normalised declaration there cannot mask
 * an outer raw check. Template TEXT stays verbatim (above). A declaration is
 * skipped as normalised only when the trimmed VALUE comes from the normaliser: a
 * normaliser in a subscript normalises the KEY, not the selected draft, so
 * `drafts[normalizeArabicIndicDigits(id)].trim()` is a raw gate.
 *
 * Round 4 (#244): three more false "already clean" reads. (a) A normalised value
 * must be the normaliser's OWN result: its closing parenthesis is matched, so
 * `normalizeArabicIndicDigits(prefix).concat(draft).trim()` is raw even though it
 * begins with the normaliser's name. (b) A comment is a TOKEN SEPARATOR, so
 * removing one leaves a space where two word characters would otherwise fuse:
 * `const` + block comment + `trimmed = draft.trim()` no longer becomes
 * `consttrimmed` and loses the declaration, while a comment between `draft.` and
 * `trim()` still reads as `draft.trim()`. (c) `breaksStatement` tracks nested
 * templates the same
 * way `scanSource` does, so a `;` in a nested template's TEXT
 * (`${flag ? `;` : draft}`) is not a statement break.
 *
 * KNOWN CEILING (say it, do not imply otherwise): detection is syntactic, so a
 * gate written as a bare truthiness test (`if (!d.trim())`, `d.trim() ? a : b`),
 * a relational `.length` test (`d.trim().length > 0`, `> 0` and `>= 1` alike), a
 * receiver that is NOT a plain member chain (`f().trim() === ""`,
 * `(draft as string).trim()`, `(draft).trim()`, `draft!.trim()`,
 * `draft.trim().trim()`, `drafts[
 id
].trim()`, `x.trimStart() === ""`,
 * `draft.trim () === ""`; the two-step form `const t = f().trim()` IS caught), a
 * blank operand that is not a `""`/`''` literal (an empty template), a value
 * assigned after a bare `let t; t = d.trim()` or aliased (`const u = t`), a second
 * declarator on one line (`const t = d.trim(), u = e.trim()`), a destructuring
 * binding, a `switch (t) { case "": }` after a raw trim, a gate in a file that
 * parses numerics without importing `amount-parse`/`numeric-input` — none of those
 * is caught. A declaration bound by `var` is not seen at all (its gate is missed),
 * and a `var`, parameter or `catch` binding can be attributed to a same-named
 * visible declaration (false positive); an ASI-ambiguous `const t = foo` followed
 * by `bar.trim();`, a continuation line (`const t = foo
 + bar.trim()`), or an
 * arrow/callback body on the right-hand side (`const t = xs.map((x) => x.trim())`,
 * whose canonical text then also loses the closing bracket) attributes that
 * `.trim()` to `t` (false positive with invented receiver text). A string or
 * template literal whose TEXT looks like a gate is still scanned as code, so it
 * can be reported as a gate it is not (false positive). That is a deliberate
 * no-change from round 2, not a ceiling: now that `${...}` is handled as code,
 * blanking only a template's TEXT is possible and would remove those false
 * positives without hiding a gate inside `${}` — a deferred follow-up, not part
 * of this change. Two more false POSITIVES are stated rather than fixed, because
 * a fourth hand-rolled lexer would grow the leak surface this brief already calls
 * the problem. (1) `normalisesWholeValue` tracks quotes flat (the bug round 4
 * fixed in `breaksStatement`), so a normaliser whose argument holds a nested
 * template is reported as raw
 * (`normalizeArabicIndicDigits(`${a ? `)` : b}`).trim()`); and
 * `withoutSubscripts` strips a `[`/`]` inside a string argument, so
 * `normalizeArabicIndicDigits(draft.replace("[", "")).trim()` is reported too.
 * Both over-report a correctly normalised value (the safe direction: a raw gate is
 * never hidden by them) and both go away with the AST walk. Regex literals
 * are not parsed, so a regex holding a quote, a backtick or a `/*` can mis-scope
 * or HIDE every later gate in the file (the unsafe direction) — in
 * `breaksStatement` and `normalisesWholeValue` as well as `scanSource` — a
 * deferred follow-up, not a dismissal. Every gate of the matched forms is caught;
 * this comment is the honest boundary of that claim.
 */

export const srcRoot = fileURLToPath(new URL("../", import.meta.url));

/** A member/chain receiver, e.g. `value.amount`, `drafts[line.id]`, `a?.b`, `this.#draft`. */
const CHAIN = String.raw`[A-Za-z_$#][\w$]*(?:\s*(?:\??\.[A-Za-z_$#][\w$]*|\??\.?\[[^\]\n]+\]))*`;
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
const DECL = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*`, "g");
const DECL_TRIM = String.raw`\.trim\(\)`;
const OPENERS = "([{";
const CLOSERS = ")]}";
const STATEMENT_KEYWORD =
  /^\s*(?:const|let|var|return|if|for|while|switch|function|export|import|throw|case|break|continue)\b/;

/**
 * Whether the two characters would FUSE into a different token if a removed
 * comment left no separator between them (`const` + `trimmed` -> `consttrimmed`).
 * Only that boundary gets a space: anywhere else the comment is dropped as it was
 * before, so a chain it interrupted (a comment between `draft.` and `trim()`)
 * stays `draft.trim()` and is still matched (#244 round 4 review). `#` is NOT a
 * word character: `this.#` + comment + `draft` must stay `this.#draft`, not
 * `this.# draft`, or the receiver is attributed to an invented `draft`.
 */
const isWordCharacter = (char: string) => /[\w$]/.test(char) || char.charCodeAt(0) > 127;
const fusesTokens = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && isWordCharacter(left) && isWordCharacter(right);

/**
 * Whether a statement break sits between `=` and the `.trim()` at bracket depth 0,
 * i.e. the `.trim()` belongs to a later statement. A bracketed group (an object
 * argument, a template `${}`) does NOT end the right-hand side; a `;`, a closing
 * bracket at depth 0, or a new line that opens a new statement does. Text inside a
 * string or template literal is skipped, so a `;` or a brace there is not a break
 * — and (round 4) templates NEST: a backtick inside `${...}` opens another
 * template rather than closing the outer one, so `${flag ? `;` : draft}` keeps its
 * `;` as text and does not discard the declaration.
 */
type BreakFrame =
  | { kind: "code"; braces: number }
  | { kind: "quote"; terminator: "'" | '"' }
  | { kind: "template" };

function breaksStatement(text: string, from: number, to: number): boolean {
  const frames: BreakFrame[] = [{ kind: "code", braces: 0 }];
  for (let i = from; i < to; i += 1) {
    const frame = frames[frames.length - 1]!;
    const char = text[i]!;
    const next = text[i + 1];
    if (frame.kind === "quote") {
      if (char === "\\") i += 1;
      else if (char === frame.terminator) frames.pop();
      continue;
    }
    if (frame.kind === "template") {
      if (char === "\\") i += 1;
      else if (char === "`") frames.pop();
      else if (char === "$" && next === "{") {
        frames.push({ kind: "code", braces: 0 });
        i += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') frames.push({ kind: "quote", terminator: char });
    else if (char === "`") frames.push({ kind: "template" });
    else if (OPENERS.includes(char)) frame.braces += 1;
    else if (char === "}") {
      if (frame.braces > 0) frame.braces -= 1;
      else if (frames.length > 1) frames.pop(); // ends the enclosing `${...}`
      else return true;
    } else if (CLOSERS.includes(char)) {
      // `)` / `]` (the `}` is handled above): a close at depth 0 ends the
      // right-hand side, so the `.trim()` belongs to a later statement
      if (frame.braces > 0) frame.braces -= 1;
      else return true;
    } else if (char === ";" && frame.braces === 0 && frames.length === 1) return true;
    else if (
      char === "\n" &&
      frame.braces === 0 &&
      frames.length === 1 &&
      STATEMENT_KEYWORD.test(text.slice(i + 1, i + 40))
    ) {
      return true;
    }
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
/** The opening of a normaliser call at the start of the trimmed value. */
const NORMALISER_CALL = /^(?:normalizeArabicIndicDigits|draftBlank)\s*\(/;

/**
 * Whether the trimmed value is the normaliser's OWN result. The normaliser's
 * matching closing parenthesis is located by depth (strings and templates are
 * skipped, so a `)` in an argument does not end the call early) and the value
 * must end there: a trailing operation (`.concat(draft)`, `+ suffix`) means the
 * normaliser did not wrap the whole value, so the trim is still raw (#244 round 4,
 * finding 1). `draftBlankish(...)` never matches (the call needs `(`), and a
 * normaliser that is only an argument of another call does not match either.
 * See `withoutSubscripts` for the subscript half of the check.
 */
function normalisesWholeValue(receiver: string): boolean {
  const match = NORMALISER_CALL.exec(receiver);
  if (match === null) return false;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = match[0].length - 1; i < receiver.length; i += 1) {
    const char = receiver[i]!;
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return receiver.slice(i + 1).trim() === "";
    }
  }
  return false;
}

/**
 * The receiver with every `[...]` subscript group removed. A normaliser in a
 * subscript normalises the KEY, and the selected draft is still raw
 * (`drafts[normalizeArabicIndicDigits(id)].trim()`, round-3 finding 2). Stripping
 * the subscript leaves `drafts`, so the declaration is reported; a normaliser
 * over the value (`normalizeArabicIndicDigits(drafts[id]).trim()`) keeps its name
 * and is still skipped. The resulting text is then passed to
 * `normalisesWholeValue` (not matched by mere presence), so a normaliser that is
 * only an ARGUMENT of another call (`f(normalizeArabicIndicDigits(id)).trim()`) is
 * still raw.
 */
function withoutSubscripts(receiver: string): string {
  let out = "";
  let depth = 0;
  for (const char of receiver) {
    if (char === "[") depth += 1;
    else if (char === "]") {
      if (depth > 0) depth -= 1;
    } else if (depth === 0) out += char;
  }
  return out;
}

export interface BlanknessGate {
  readonly file: string;
  readonly line: number;
  /** `file::<canonical gate text>` — stable across line drift. */
  readonly signature: string;
}

/**
 * One pass over the source producing (a) the comment-stripped text and (b) the
 * matched brace pairs *of that text*, with a template expression `${...}` treated
 * as CODE in both passes. Doing them together is the point: a comment inside
 * `${}` is stripped, so a gate split by it is still a gate, and a brace inside
 * `${}` pairs, so a declaration nested there does not share the enclosing scope
 * of a comparison outside it. Both are round-3 finding 1 — a template expression
 * was text to this scanner while `collectDeclarations` still read its
 * declarations, so an inner normalised `trimmed` hid an outer raw `trimmed ===
 * ""`. The template TEXT between groups is still copied verbatim — a deliberate
 * no-change from round 2, because this change is about the expression half.
 * Blanking a template's TEXT is now possible (the `${...}` half is code either
 * way) and would only remove false positives; it is a deferred follow-up, not a
 * ceiling. Newlines survive every branch, so line numbers hold.
 */
function scanSource(source: string): ScanResult {
  let out = "";
  const braces: BracePair[] = [];
  const opens: number[] = [];
  type Region =
    | { kind: "code"; interpolation: number | null }
    | { kind: "template" }
    | { kind: "line" }
    | { kind: "block" }
    | { kind: "quote"; terminator: "'" | '"' };
  const regions: Region[] = [{ kind: "code", interpolation: null }];

  for (let i = 0; i < source.length; i += 1) {
    const region = regions[regions.length - 1]!;
    const char = source[i]!;
    const next = source[i + 1];

    if (region.kind === "line") {
      if (char === "\n") {
        regions.pop();
        out += char;
      }
      continue;
    }
    if (region.kind === "block") {
      if (char === "*" && next === "/") {
        regions.pop();
        // a comment is a token SEPARATOR, not nothing: `const` + comment +
        // `trimmed` must not fuse into `consttrimmed`, which loses the
        // declaration and the gate that follows it. It only needs a space where
        // two word characters would fuse; elsewhere dropping it keeps every
        // offset (and every brace pair) as it was, and keeps a chain it
        // interrupted (`draft./* note */trim()`) matchable.
        if (fusesTokens(out[out.length - 1], source[i + 2])) out += " ";
        i += 1;
      } else if (char === "\n") {
        out += "\n";
      }
      continue;
    }
    if (region.kind === "quote") {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === region.terminator) {
        regions.pop();
      }
      continue;
    }
    if (region.kind === "template") {
      if (char === "\\") {
        out += char + (next ?? "");
        i += 1;
        continue;
      }
      if (char === "`") {
        regions.pop();
        out += char;
        continue;
      }
      if (char === "$" && next === "{") {
        // the interpolation braces are a scope, so a declaration inside `${}` is
        // not visible to a comparison outside it
        const at = out.length;
        opens.push(at);
        regions.push({ kind: "code", interpolation: at });
        out += "${";
        i += 1;
        continue;
      }
      out += char;
      continue;
    }
    // code region
    if (char === "/" && next === "/") {
      regions.push({ kind: "line" });
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      regions.push({ kind: "block" });
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      regions.push({ kind: "quote", terminator: char });
      out += char;
      continue;
    }
    if (char === "`") {
      regions.push({ kind: "template" });
      out += char;
      continue;
    }
    if (char === "{") {
      opens.push(out.length);
      out += char;
      continue;
    }
    if (char === "}") {
      const open = opens.pop();
      if (open !== undefined) braces.push({ open, close: out.length });
      // only the interpolation's OWN brace ends the region: an inner `{...}` (an
      // object literal, an arrow body) must not turn the rest of the template
      // back into text, which would stop stripping its comments and scoping it
      if (region.interpolation !== null && open === region.interpolation) regions.pop();
      out += char;
      continue;
    }
    out += char;
  }
  return { code: out, braces };
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

/** The comment-stripped source and the brace pairs within it, from one pass. */
interface ScanResult {
  readonly code: string;
  readonly braces: BracePair[];
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
  const { code: text, braces } = scanSource(source);
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
      if (declaration === undefined || normalisesWholeValue(withoutSubscripts(declaration.rhs))) continue;
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
