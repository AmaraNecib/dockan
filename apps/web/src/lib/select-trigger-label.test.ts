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
 * without an `items` map fails here instead of shipping a trigger that says `WE_OWE`
 * (or an invoice uuid). It is a TypeScript AST walk, not a regex: half these roots
 * carry an inline arrow function in the opening tag, and `[^>]*` cannot see past
 * that `>` — the lesson `lib/cell-ltr.test.ts` records.
 *
 * A statically empty map counts as no map: `items={[]}`, `items={undefined}` and
 * `items={null}` all fall straight back to the raw value, so they are red here
 * rather than passing as a placeholder that satisfies the letter of the guard.
 *
 * Boundary — deliberate, in the "state the syntactic ceiling" spirit of
 * `tests/blankness-gates.ts`. The walk resolves LITERAL tag names inside a
 * `<Select>` element's own JSX children. Out of reach, and named so a reviewer
 * can judge the miss: an aliased import (`Select as Picker`), a namespaced tag
 * (`<Select.Root>`), a root built by `createElement`, and a trigger rendered by
 * another component (a wrapper that renders `<SelectValue>` itself). Those need
 * symbol resolution this scanner does not do. A nested `<Select>` root inside
 * another is NOT a blind spot: its subtree is skipped, so only the root that owns
 * the `SelectValue` is judged.
 */

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

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

/** The `items={…}` initializer, or null when there is no usable one. */
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

/** True when the root supplies a map that is not statically empty. */
function hasItemsMap(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  const expression = itemsExpression(opening);
  if (expression === null) return false;
  if (ts.isArrayLiteralExpression(expression) && expression.elements.length === 0) return false;
  if (ts.isObjectLiteralExpression(expression) && expression.properties.length === 0) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(expression) && (expression.text === "undefined" || expression.text === "null")) return false;
  return true;
}

/** `<Select>` roots that render a `<SelectValue>` but pass no usable `items` map. */
export function selectValueSitesWithoutItems(sourceText: string): Array<{ line: number; text: string }> {
  const sourceFile = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select" && rendersSelectValue(node) && !hasItemsMap(node.openingElement)) {
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

/** How many `<Select>` roots the walker can see at all — the scan's own positive
 * control, so a walker that returns nothing cannot pass vacuously. */
export function selectRootsSeen(sourceText: string): number {
  const sourceFile = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let seen = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select") seen += 1;
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

    // a statically empty map is no map: the trigger falls back to the raw value
    expect(check(bare.replace("<Select value={direction}", "<Select value={direction} items={[]}"))).toBe(1);
    expect(check(bare.replace("<Select value={direction}", "<Select value={direction} items={undefined}"))).toBe(1);

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
  });

  it("gives every Select that renders a SelectValue a value→label map", () => {
    const files = walkTsx(srcRoot);
    const offenders: string[] = [];
    let rootsSeen = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      rootsSeen += selectRootsSeen(source);
      for (const site of selectValueSitesWithoutItems(source)) {
        offenders.push(`${file.slice(srcRoot.length)}:${site.line} ${site.text}`);
      }
    }
    // positive control: the walker must have found the app's real Select roots, or
    // an empty offender list would mean "nothing was scanned", not "nothing wrong"
    expect(rootsSeen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
