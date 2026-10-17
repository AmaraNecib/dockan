import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { walkTsx } from "../tests/source-scan";

/**
 * Select-trigger label guard (issue #252).
 *
 * `<SelectValue />` is Base UI's `Select.Value`. With no `items` map on
 * `Select.Root` it renders the RAW value — `resolveSelectedLabel(value, items, …)`
 * falls through to `stringifyAsLabel(value)` — so the trigger of a direction select
 * printed `WE_OWE` while the popup beside it printed the Arabic labels. The label
 * appears only when the root supplies the value→label map, which
 * `components/ui/select.test.tsx` already documents for the primitive.
 *
 * This scans the real source, so a future `<Select>` that renders a `<SelectValue>`
 * without a usable `items` map fails here instead of shipping a trigger that says
 * `WE_OWE` (or an invoice uuid). It is a TypeScript AST walk, not a regex: half
 * these roots carry an inline arrow function in the opening tag, and `[^>]*`
 * cannot see past that `>` — the lesson `lib/cell-ltr.test.ts` records.
 *
 * A map that cannot carry a label is treated as no map, because each shape falls
 * straight back to the raw value and must not pass as a placeholder:
 *   - statically empty: `items={[]}`, `items={[] as const}`, `items={(undefined)}`,
 *     `items={null}` and `items={EMPTY}` where this file declares `const EMPTY = []`;
 *   - a label that IS its value: `items={[{ value: "WE_OWE", label: "WE_OWE" }]}`
 *     (quoted keys and plain string literals; a computed value is not decidable).
 *
 * The empty-array binding lookup is file-wide, not scope-aware: a `const EMPTY =
 * []` anywhere in the file makes every `items={EMPTY}` red. That is a false
 * positive, never a false negative, and the fix in the failing file is to inline
 * the map.
 *
 * Boundary — deliberate, in the "state the syntactic ceiling" spirit of
 * `tests/blankness-gates.ts`. The walk resolves LITERAL tag names inside a
 * `<Select>` element's own JSX children. Out of reach, and named so a reviewer can
 * judge the miss: an aliased import (`Select as Picker`), a namespaced tag
 * (`<Select.Root>`, which `components/ui/select.tsx` itself uses), a root built by
 * `createElement`, a trigger rendered by another component, and a map built by a
 * non-literal expression. Those need symbol resolution this scanner does not do.
 * A nested `<Select>` root inside another is NOT a blind spot: its subtree is
 * skipped, so only the root that owns the `SelectValue` is judged.
 */

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

/** The app has at least this many trigger-bearing roots (27 at `4458560`); a
 * walker that sees fewer has stopped walking, and its empty offender list would
 * mean nothing. */
const MIN_TRIGGER_ROOTS = 10;

function tagNameOf(node: ts.JsxTagNameExpression): string | null {
  return ts.isIdentifier(node) ? node.text : null;
}

/** Does an element's own JSX children render a `SelectValue`? A nested `<Select>`
 * owns its `SelectValue`, so its subtree is not descended into. */
function rendersSelectValue(element: ts.JsxElement): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const name = ts.isJsxElement(child) ? tagNameOf(child.openingElement.tagName) : tagNameOf(child.tagName);
      if (name === "SelectValue") {
        found = true;
        return;
      }
      // another root's trigger is that root's problem, not this one's
      if (name === "Select") return;
    }
    ts.forEachChild(child, visit);
  };
  for (const child of element.children) visit(child);
  return found;
}

/** Peel `(x)`, `x as const` and `<T>x` down to the expression that decides the map. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Names this file binds to an empty array literal (`const EMPTY = []`), so
 * `items={EMPTY}` is judged empty rather than "some map". */
function emptyArrayBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer) && initializer.elements.length === 0) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** The `items={…}` initializer, or null when there is no syntax for one. */
function itemsExpression(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.Expression | null {
  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name) || property.name.text !== "items") continue;
    const initializer = property.initializer;
    if (initializer === undefined) return null;
    if (ts.isJsxExpression(initializer)) return initializer.expression ?? null;
    return null;
  }
  return null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function staticStringText(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteral(unwrapped) ? unwrapped.text : null;
}

function propertyString(object: ts.ObjectLiteralExpression, name: string): string | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) !== name) continue;
    return staticStringText(property.initializer);
  }
  return null;
}

/** True when the map hands the trigger back the very string it should replace. */
function labelsAreRawValues(expression: ts.Expression): boolean {
  const array = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(array)) return false;
  return array.elements.some((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    const value = propertyString(element, "value");
    return value !== null && value === propertyString(element, "label");
  });
}

/** A usable map resolves a value to a label. Null-ish, statically empty or
 * self-labelling shapes do not, and are red. */
function isUsableMap(expression: ts.Expression | null, emptyBindings: ReadonlySet<string>): boolean {
  if (expression === null) return false;
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 0) return false;
  if (ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length === 0) return false;
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(unwrapped) && (unwrapped.text === "undefined" || unwrapped.text === "null" || emptyBindings.has(unwrapped.text))) return false;
  return !labelsAreRawValues(unwrapped);
}

/** `<Select>` roots that render a `<SelectValue>` but pass no usable `items` map. */
export function selectValueSitesWithoutItems(sourceText: string): Array<{ line: number; text: string }> {
  const sourceFile = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const emptyBindings = emptyArrayBindings(sourceFile);
  const offenders: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select" && rendersSelectValue(node) && !isUsableMap(itemsExpression(node.openingElement), emptyBindings)) {
      offenders.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        text: node.openingElement.getText(sourceFile).replace(/\s+/g, " "),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

/** Count of trigger-bearing roots — the scan's own positive control, so a walker
 * that sees nothing cannot pass with an empty offender list. */
export function selectValueRootsSeen(sourceText: string): number {
  const sourceFile = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let seen = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select" && rendersSelectValue(node)) seen += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return seen;
}

const check = (source: string) => selectValueSitesWithoutItems(source).length;

describe("Select trigger label guard (issue #252)", () => {
  it("reddens on each shape the bug and its near-misses take", () => {
    // the exact bug shape: a root with no items map and a bare SelectValue
    const bare = `<Select value={direction} onValueChange={(next) => setDirection(next)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="WE_OWE">{t("we")}</SelectItem></SelectContent>
    </Select>`;
    expect(check(bare)).toBe(1);

    // the fix
    expect(check(bare.replace("<Select value={direction}", "<Select value={direction} items={DIRECTION_ITEMS}"))).toBe(0);

    // every statically empty shape is no map: the trigger falls back to the raw value
    for (const empty of ["[]", "[] as const", "( undefined )", "null"]) {
      expect({ empty, offenders: check(bare.replace("<Select value={direction}", `<Select value={direction} items={${empty}}`)) }).toEqual({ empty, offenders: 1 });
    }

    // a name bound to an empty array literal in the same file is empty too
    const bound = `const EMPTY = [] as const;\n${bare.replace("<Select value={direction}", "<Select value={direction} items={EMPTY}")}`;
    expect(check(bound)).toBe(1);

    // a map that hands the trigger its own value back is no map either — with an
    // unquoted key or a quoted one
    const selfLabelled = bare.replace("<Select value={direction}", '<Select value={direction} items={[{ value: "WE_OWE", label: "WE_OWE" }]}');
    expect(check(selfLabelled)).toBe(1);
    const selfLabelledQuoted = bare.replace("<Select value={direction}", '<Select value={direction} items={[{ "value": "WE_OWE", "label": "WE_OWE" }]}');
    expect(check(selfLabelledQuoted)).toBe(1);

    // an empty object literal is no map
    expect(check(bare.replace("<Select value={direction}", "<Select value={direction} items={{}}"))).toBe(1);

    // the outer root has no SelectValue of its own: it must NOT be blamed for the
    // nested root's trigger
    const nested = `<Select value={a} items={A}>
      <SelectTrigger>{t("pick")}</SelectTrigger>
      <SelectContent>
        <Select value={b}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="b">{t("b")}</SelectItem></SelectContent>
        </Select>
      </SelectContent>
    </Select>`;
    expect(check(nested)).toBe(1);
    expect(selectValueRootsSeen(nested)).toBe(1);
  });

  it("gives every Select that renders a SelectValue a usable value→label map", () => {
    const offenders: string[] = [];
    let rootsSeen = 0;
    for (const file of walkTsx(srcRoot)) {
      const source = readFileSync(file, "utf8");
      rootsSeen += selectValueRootsSeen(source);
      for (const site of selectValueSitesWithoutItems(source)) {
        offenders.push(`${file.slice(srcRoot.length)}:${site.line} ${site.text}`);
      }
    }
    // positive control: the walker must have found the app's real trigger-bearing
    // roots, or an empty offender list would mean "nothing was scanned"
    expect(rootsSeen).toBeGreaterThanOrEqual(MIN_TRIGGER_ROOTS);
    expect(offenders).toEqual([]);
  });
});
