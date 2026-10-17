import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
 * Boundary: the walk sees a `SelectValue` inside the `<Select>` element's own JSX
 * subtree. A trigger built by a wrapper component that renders `<SelectValue>`
 * itself, or a `Select` created from a variable rather than a JSX tag, is outside
 * this guard.
 */

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

function walkTsx(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkTsx(path));
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) files.push(path);
  }
  return files;
}

function tagNameOf(node: ts.JsxTagNameExpression): string | null {
  return ts.isIdentifier(node) ? node.text : null;
}

/** Does this element's JSX subtree render a `SelectValue` element? */
function rendersSelectValue(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if ((ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) && tagNameOf(child.tagName) === "SelectValue") {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function hasItemsAttribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return node.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === "items",
  );
}

/** `<Select>` roots that render a `<SelectValue>` but pass no `items` map. */
export function selectValueSitesWithoutItems(sourceText: string): Array<{ line: number; text: string }> {
  const sourceFile = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxElement(node) &&
      tagNameOf(node.openingElement.tagName) === "Select" &&
      rendersSelectValue(node) &&
      !hasItemsAttribute(node.openingElement)
    ) {
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

describe("Select trigger label guard (issue #252)", () => {
  it("catches a SelectValue whose root has no items map (the guard's own mutation)", () => {
    // the guard must redden on its own subject: this is the exact shape the bug had
    const bare = `
      export function Bad() {
        return (
          <Select value={direction} onValueChange={(next) => setDirection(next)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="WE_OWE">{t("we")}</SelectItem></SelectContent>
          </Select>
        );
      }`;
    expect(selectValueSitesWithoutItems(bare)).toHaveLength(1);

    const mapped = bare.replace("<Select value={direction}", "<Select value={direction} items={DIRECTION_ITEMS}");
    expect(selectValueSitesWithoutItems(mapped)).toEqual([]);
  });

  it("gives every Select that renders a SelectValue a value→label map", () => {
    const offenders: string[] = [];
    for (const file of walkTsx(srcRoot)) {
      const relative = file.slice(srcRoot.length);
      for (const site of selectValueSitesWithoutItems(readFileSync(file, "utf8"))) {
        offenders.push(`${relative}:${site.line} ${site.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
