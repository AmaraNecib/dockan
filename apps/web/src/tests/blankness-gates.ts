import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * #249 — the scanner behind the raw-`.trim()` blankness ratchet, now a
 * TypeScript AST walk.
 *
 * #244 built this scanner out of regexes over a hand-stripped source string. Four
 * review rounds each found a new *lexing* failure — line layout, inner-block
 * scope, `${}` treated as text, normalised keys, appended calls, comment
 * separators, nested templates — and round 4's fixes introduced two new escapes.
 * Every one of them is a rule a real parser applies for free. This file replaces
 * the two regex passes (`scanSource` + six inline matchers +
 * `collectDeclarations` / `breaksStatement`) with `ts.createSourceFile()` + one
 * walk over `CallExpression` / `BinaryExpression` / declarations.
 *
 * The seam is unchanged on purpose: `numericReaderFiles()` and `CLASSIFIED`
 * (`blankness-ratchet.test.ts`) keep their meaning, and every signature string is
 * byte-identical, so `gate-set-diff` can assert the classification set did not
 * move.
 *
 * A gate's identity is `file::<canonical gate text>`, not a line number. The
 * canonical text is the same vocabulary #244 used:
 *
 *   R.trim() OP ""            "" OP R.trim()
 *   R.trim().length OP 0      0 OP R.trim().length
 *   X OP "" [R.trim()]        "" OP X [R.trim()]
 *   X.length OP 0 [R.trim()]  0 OP X.length [R.trim()]
 *
 * where OP is `===` / `!==` / `==` / `!=`, `R` is the `.trim()` receiver's source
 * text (whitespace collapsed) and `X` is a binding whose initializer is a raw
 * `.trim()` call. `?.trim()` canonicalises to `.trim()`, and `''` to `""`.
 *
 * A receiver is NORMALISED — not a raw gate — exactly when it is a call to
 * `normalizeArabicIndicDigits` / `draftBlank` (optionally parenthesised). Because
 * the AST receiver *is* the whole value, that one rule subsumes #244's
 * `normalisesWholeValue` + `withoutSubscripts`: a trailing `.concat(...)` is a
 * different receiver (raw) and a normaliser in a subscript is a different
 * receiver (raw).
 *
 * FAIL CLOSED. The walk visits every node, so a `.trim()` call cannot be skipped
 * by a lexing desync (a regex literal holding `"`, `` ` ``, `//` or `/*` is now a
 * node, not a region change). Every raw `.trim()` (and every `.trim().length`,
 * and every `.length` of a raw-trim binding) is classified by its position: a
 * handled comparison is a gate, a value use is named as not-a-gate, and a
 * boolean/blankness TEST the registry does not handle throws `BlanknessScanError`
 * — a loud refusal, never silence. That covers truthiness (`!x.trim()`,
 * `if (x.trim())`, `x.trim() ? a : b`, `x.trim() && a`), `x.trim().length`
 * truthiness (`if (x.trim().length)`, `!x.trim().length`), a relational
 * `.trim()` / `.trim().length` (`> 0`, `>= 1`) and an empty-template operand.
 * A blind spot that reports nothing is the failure mode this ticket exists to end.
 *
 * Two scope/position rules the walk applies exactly (Greptile #251 findings 1 and
 * 2): a `for` / `for-of` / `for-in` statement is the scope for its own
 * `let`/`const` bindings, so a loop binding cannot mask an outer raw check after
 * the loop; and a comma expression is followed to its right-most operand before
 * the surrounding test position is judged — a comma's left operand is discarded,
 * so a raw trim there is a value use, not a test.
 *
 * KNOWN CEILING (say it, do not imply otherwise): detection is still syntactic
 * and the gate vocabulary is still #244's, so these shapes are not gates:
 * the truthiness/relational/empty-template tests above are REFUSED rather than
 * detected; a binding formed by assignment (`let t; t = d.trim()`) or
 * destructuring, and a computed `.trim` property (`d["trim"]()`), are not gate
 * sources; `switch (t) { case "": }` after a raw trim is not a comparison;
 * `Boolean(x.trim())` is an explicit call, so its argument is a value use, not a
 * test; and visibility is lexical, not typed, so a parameter or `catch` binding
 * that shadows a raw-trim local can still be attributed to the local. A file that
 * does not parse is recovered by TS rather than refused (parse diagnostics are
 * not inspected); production files parse clean.
 */

export const srcRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Files that are in scope because they read a numeric draft, even though they no
 * longer import the reader themselves: #255 moved the opening-balance typed-row
 * reader into `lib/supplier-opening-draft.ts`, and this page's date and reason
 * gates must keep being classified. The rule is the ROLE (a file that decides what
 * a draft means), not the import.
 */
const EXPLICIT_READERS = ["pages/supplier-opening-balance.tsx"];

/** Thrown when a raw `.trim()` sits in a blankness-test shape the walk does not
 * classify. Fail closed: an unhandled shape is a loud refusal, never a skip. */
export class BlanknessScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlanknessScanError";
  }
}

export interface BlanknessGate {
  readonly file: string;
  readonly line: number;
  /** `file::<canonical gate text>` — stable across line drift. */
  readonly signature: string;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A receiver's canonical text, with comment trivia dropped and whitespace
 * collapsed, so a comment edit cannot change a gate's identity. The printer
 * drops only comments — text inside a literal (`a["//"]`, a template) is
 * preserved — which a second hand-rolled comment stripper could not promise.
 */
const RECEIVER_PRINTER = ts.createPrinter({ removeComments: true });
const receiverText = (expression: ts.Expression): string =>
  collapse(RECEIVER_PRINTER.printNode(ts.EmitHint.Unspecified, expression, expression.getSourceFile()));

const COMPARISON_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const RELATIONAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

const NORMALISERS = new Set(["normalizeArabicIndicDigits", "draftBlank"]);

const SCRIPT_KIND = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Strip the wrappers that do not change a value: parens, assertions, `!`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A zero-argument `.trim()` call: `x.trim()` or `x?.trim()`. */
function isTrimCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length !== 0) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "trim";
}

const trimReceiver = (call: ts.CallExpression): ts.Expression => {
  // SAFETY: callers pass a call that `isTrimCall()` accepted, which requires the
  // callee to be a property access named `trim`.
  return (call.expression as ts.PropertyAccessExpression).expression;
};

const isLengthAccess = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && node.name.text === "length";

const isEmptyString = (node: ts.Node): boolean => ts.isStringLiteral(node) && node.text === "";

const isEmptyTemplate = (node: ts.Node): boolean =>
  ts.isNoSubstitutionTemplateLiteral(node) && node.text === "";

const isZero = (node: ts.Node): boolean => ts.isNumericLiteral(node) && node.text === "0";

/** Whether a receiver is the normaliser's OWN result, i.e. the whole value. */
function isNormalisedReceiver(expression: ts.Expression): boolean {
  const receiver = unwrap(expression);
  if (!ts.isCallExpression(receiver) || receiver.arguments.length === 0) return false;
  const callee = unwrap(receiver.expression);
  return ts.isIdentifier(callee) && NORMALISERS.has(callee.text);
}

/**
 * The raw `.trim()` a binding holds: the initializer itself, or the trimmed left
 * of a `trim() ?? ""` fallback (`const t = draft?.trim() ?? ""`). The fallback is
 * a real blankness source — the regex scanner reported it, so dropping it would
 * be a silent blind spot, not a stated ceiling.
 */
function trimmedInitializer(initializer: ts.Expression): ts.CallExpression | undefined {
  const node = unwrap(initializer);
  if (isTrimCall(node)) return node;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    if (isTrimCall(left) && (isEmptyString(right) || isEmptyTemplate(right))) return left;
  }
  return undefined;
}

/** The nearest block-like ancestor: a block-scoped declaration does not leak
 * out of it. */
function nearestScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    switch (current.kind) {
      case ts.SyntaxKind.SourceFile:
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.ModuleBlock:
      case ts.SyntaxKind.CaseBlock:
        return current;
      default:
        current = current.parent;
    }
  }
  return node.getSourceFile();
}

/**
 * The `for` / `for-of` / `for-in` statement a `let`/`const` declaration is the
 * initializer of: the loop itself is that binding's scope, so it does not leak
 * into the surrounding block. Without this, `for (let t = normalised; …)` was
 * treated as visible after the loop and masked an outer raw `t` (Greptile #251
 * finding 1: the walk returned `[]` for a real raw check with no refusal).
 */
function loopScope(node: ts.Node): ts.Node | undefined {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  const owner = list.parent;
  if (ts.isForStatement(owner) && owner.initializer === list) return owner;
  if ((ts.isForOfStatement(owner) || ts.isForInStatement(owner)) && owner.initializer === list) return owner;
  return undefined;
}

/** The nearest function (or the file): a `var` hoists to here, so a `var` inside
 * a block is still visible after that block closes. */
function nearestFunctionScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current) || current.kind === ts.SyntaxKind.SourceFile) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** The first parent that is not a value-preserving wrapper. */
function transparentParent(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * The node whose VALUE is the one under test. Parens / assertions / `!`-free
 * wrappers preserve the value, and a comma expression's value is its right-most
 * operand; a comma's left operand is DISCARDED, so a raw trim there is a value
 * use, not a test. (Greptile #251 finding 2: `refuseIfTestPosition` stopped at
 * the comma expression, so `if ((logDraft(), draft.trim()))` returned `[]` with
 * no refusal.)
 */
function testedValue(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return current;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      parent.right === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

interface Declaration {
  readonly name: string;
  /** The raw `.trim()` call in the initializer. */
  readonly trim: ts.CallExpression;
  readonly offset: number;
  /** The innermost scope node the binding lives in. */
  readonly scope: ts.Node;
  readonly normalised: boolean;
}

/** Every raw-`.trim()` blankness gate in one source string. */
export function findBlanknessGates(source: string, file: string): BlanknessGate[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    SCRIPT_KIND(file),
  );
  const declarations: Declaration[] = [];
  const bySignature = new Map<string, { offset: number; gate: BlanknessGate }>();

  const record = (offset: number, canonical: string) => {
    const signature = `${file}::${canonical}`;
    if (bySignature.has(signature)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(offset);
    bySignature.set(signature, { offset, gate: { file, line: line + 1, signature } });
  };

  const refuse = (node: ts.Node, reason: string): never => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    throw new BlanknessScanError(
      `unhandled blankness shape (${reason}) at ${file}:${line + 1}: ${collapse(node.getText(sourceFile))}`,
    );
  };

  const visibleDeclaration = (name: string, comparison: ts.Node): Declaration | undefined => {
    const comparisonStart = comparison.getStart(sourceFile);
    let found: Declaration | undefined;
    for (const declaration of declarations) {
      if (declaration.name !== name) continue;
      if (declaration.offset >= comparisonStart) continue;
      if (!isAncestor(declaration.scope, comparison)) continue;
      found = declaration; // declarations are pushed in source order: keep the innermost preceding
    }
    return found;
  };

  /** Whether an expression reads a RAW trim (so a relational test on it is a
   * blankness test we have not handled). */
  const isRawTrimExpression = (expression: ts.Expression, comparison: ts.Node): boolean => {
    const node = unwrap(expression);
    if (isTrimCall(node)) return !isNormalisedReceiver(trimReceiver(node));
    if (isLengthAccess(node)) {
      const on = unwrap(node.expression);
      if (isTrimCall(on)) return !isNormalisedReceiver(trimReceiver(on));
      if (!ts.isIdentifier(on)) return false;
      const declaration = visibleDeclaration(on.text, comparison);
      return declaration !== undefined && !declaration.normalised;
    }
    if (!ts.isIdentifier(node)) return false;
    const declaration = visibleDeclaration(node.text, comparison);
    return declaration !== undefined && !declaration.normalised;
  };

  const classifyBlankOperand = (
    expression: ts.Expression,
    comparison: ts.BinaryExpression,
    offset: number,
    operator: string,
    blankFirst: boolean,
    blankKind: "string" | "zero",
  ) => {
    const blankText = blankKind === "string" ? '""' : "0";
    const anchor = (expressionText: string, suffix = "") =>
      record(
        offset,
        blankFirst
          ? `${blankText} ${operator} ${expressionText}${suffix}`
          : `${expressionText} ${operator} ${blankText}${suffix}`,
      );

    if (blankKind === "string") {
      if (isTrimCall(expression)) {
        if (!isNormalisedReceiver(trimReceiver(expression))) {
          anchor(`${receiverText(trimReceiver(expression))}.trim()`);
        }
        return;
      }
      if (!ts.isIdentifier(expression)) return;
      const declaration = visibleDeclaration(expression.text, comparison);
      if (declaration === undefined || declaration.normalised) return;
      const rhs = receiverText(trimReceiver(declaration.trim));
      anchor(expression.text, ` [${rhs}.trim()]`);
      return;
    }

    if (!isLengthAccess(expression)) return;
    const on = unwrap(expression.expression);
    if (isTrimCall(on)) {
      if (!isNormalisedReceiver(trimReceiver(on))) {
        anchor(`${receiverText(trimReceiver(on))}.trim().length`);
      }
      return;
    }
    if (!ts.isIdentifier(on)) return;
    const declaration = visibleDeclaration(on.text, comparison);
    if (declaration === undefined || declaration.normalised) return;
    const rhs = receiverText(trimReceiver(declaration.trim));
    anchor(`${on.text}.length`, ` [${rhs}.trim()]`);
  };

  const classifyComparison = (comparison: ts.BinaryExpression) => {
    const operatorKind = comparison.operatorToken.kind;
    const offset = comparison.getStart(sourceFile);
    const operator = comparison.operatorToken.getText(sourceFile);
    const left = unwrap(comparison.left);
    const right = unwrap(comparison.right);

    if (RELATIONAL_OPERATORS.has(operatorKind)) {
      if (
        isRawTrimExpression(left, comparison) ||
        isRawTrimExpression(right, comparison)
      ) {
        refuse(comparison, "relational test on a raw .trim()");
      }
      return;
    }
    if (!COMPARISON_OPERATORS.has(operatorKind)) return;

    if (isEmptyString(left)) {
      classifyBlankOperand(right, comparison, offset, operator, true, "string");
    } else if (isEmptyString(right)) {
      classifyBlankOperand(left, comparison, offset, operator, false, "string");
    } else if (isZero(left)) {
      classifyBlankOperand(right, comparison, offset, operator, true, "zero");
    } else if (isZero(right)) {
      classifyBlankOperand(left, comparison, offset, operator, false, "zero");
    } else if (
      (isEmptyTemplate(left) && isRawTrimExpression(right, comparison)) ||
      (isEmptyTemplate(right) && isRawTrimExpression(left, comparison))
    ) {
      refuse(comparison, "empty template literal operand");
    }
  };

  /** Refuse a raw trim (or its `.length`) that feeds a boolean/relational test
   * the gate registry does not handle. The comparison walk owns the `=== ""` /
   * `=== 0` / relational forms; a value use is not a test. */
  const refuseIfTestPosition = (node: ts.Node): void => {
    // The tested value is the node's value through parens and comma expressions:
    // `(a, b)` is tested as `b`, while a comma's left operand is discarded.
    const owner = transparentParent(testedValue(node));
    if (owner === undefined) return;
    if (ts.isBinaryExpression(owner)) {
      const kind = owner.operatorToken.kind;
      if (COMPARISON_OPERATORS.has(kind) || RELATIONAL_OPERATORS.has(kind)) return;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
        refuse(node, "truthiness test on a raw .trim()");
      }
      return;
    }
    if (ts.isPrefixUnaryExpression(owner) && owner.operator === ts.SyntaxKind.ExclamationToken) {
      refuse(node, "truthiness test on a raw .trim()");
    }
    if (ts.isConditionalExpression(owner) && isAncestor(owner.condition, node)) {
      refuse(node, "truthiness test on a raw .trim()");
    }
    if (ts.isIfStatement(owner) && isAncestor(owner.expression, node)) {
      refuse(node, "truthiness test on a raw .trim()");
    }
    if (ts.isWhileStatement(owner) && isAncestor(owner.expression, node)) {
      refuse(node, "truthiness test on a raw .trim()");
    }
    if (ts.isDoStatement(owner) && isAncestor(owner.expression, node)) {
      refuse(node, "truthiness test on a raw .trim()");
    }
    if (ts.isForStatement(owner) && owner.condition !== undefined && isAncestor(owner.condition, node)) {
      refuse(node, "truthiness test on a raw .trim()");
    }
  };

  const classifyTrimUse = (call: ts.CallExpression) => {
    if (isNormalisedReceiver(trimReceiver(call))) return;
    const parent = transparentParent(call);
    if (parent === undefined) return;
    if (isLengthAccess(parent)) return; // the `.length` branch below owns it
    refuseIfTestPosition(call);
  };

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const trim = trimmedInitializer(node.initializer);
      if (trim !== undefined) {
        const list = node.parent;
        const blockScoped =
          ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0;
        declarations.push({
          name: node.name.text,
          trim,
          offset: node.getStart(sourceFile),
          scope: blockScoped ? loopScope(node) ?? nearestScope(node) : nearestFunctionScope(node),
          normalised: isNormalisedReceiver(trimReceiver(trim)),
        });
      }
    }
    if (ts.isBinaryExpression(node)) classifyComparison(node);
    if (isTrimCall(node)) classifyTrimUse(node);
    if (isLengthAccess(node) && isRawTrimExpression(node, node)) refuseIfTestPosition(node);
    if (ts.isIdentifier(node)) {
      // A bound raw trim tested for truthiness is the same unhandled blankness
      // shape as the call itself: fail closed, never skip it.
      const declaration = visibleDeclaration(node.text, node);
      if (declaration !== undefined && !declaration.normalised) refuseIfTestPosition(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return [...bySignature.values()]
    .sort((a, b) => a.offset - b.offset)
    .map((entry) => entry.gate);
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
  const explicit = EXPLICIT_READERS.map((path) => join(srcRoot, path));
  const selected = new Set([...readers, ...imported, ...explicit]);
  return [...selected].map((path) => relative(srcRoot, path).split("\\").join("/")).sort();
}

/** Every gate in the scope, ready for the classifier. */
export function scanNumericDraftReaders(): BlanknessGate[] {
  return numericReaderFiles().flatMap((file) =>
    findBlanknessGates(readFileSync(join(srcRoot, file), "utf8"), file),
  );
}
