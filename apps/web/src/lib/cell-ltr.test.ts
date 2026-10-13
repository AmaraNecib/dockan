import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RTL table-cell regression guard (issue #166).
 *
 * `dir="ltr"` on a block/table cell makes `text-align: start` resolve to the
 * LEFT edge, so a number cell stops lining up under its right-aligned RTL
 * header. The fix is the shared `.cell-ltr` utility (direction + isolate +
 * text-align: right) applied where the cell needs an LTR run; inline
 * `<span dir="ltr">` runs are correct and stay as they are.
 *
 * The test scans the real source so a future cell that reintroduces
 * `dir="ltr"` on a `<td>`/`<th>`/`TableCell`/`<TableHead>` fails here, and
 * pins the utility definition in index.css.
 */

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

function walkTsx(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkTsx(path));
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) files.push(path);
  }
  return files;
}

// a cell opening tag carrying dir="ltr" (any quote/JSX-expression spelling,
// order-independent, multi-line safe)
const CELL_WITH_LTR = /<(?:td|th|TableCell|TableHead)\b[^>]*?\bdir=(?:"ltr"|'ltr'|\{\s*["']ltr["']\s*\})/gs;

describe(".cell-ltr utility (issue #166)", () => {
  it("is defined in index.css and pins the digit run to the header edge", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const block = /\.cell-ltr\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain("direction: ltr");
    expect(block).toContain("unicode-bidi: isolate");
    expect(block).toContain("text-align: right");
  });

  it("leaves no table cell carrying a bare dir=\"ltr\"", () => {
    const offenders: string[] = [];
    for (const file of walkTsx(srcRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(CELL_WITH_LTR)) {
        offenders.push(`${file.replace(srcRoot, "src/")}: ${match[0].split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("applies the utility to every audited cell (invoice, phone, ref, return, print)", () => {
    // exact per-file counts: a dropped class on one of party-detail's two cells
    // must fail, not be masked by the other
    const expected = {
      "pages/party-detail.tsx": 3,
      "pages/invoice.tsx": 1,
      "pages/parties.tsx": 1,
      "pages/activity.tsx": 1,
      "components/print-sheet.tsx": 1,
    };
    for (const [relative, count] of Object.entries(expected)) {
      const source = readFileSync(join(srcRoot, relative), "utf8");
      const found = source.match(/cell-ltr/g)?.length ?? 0;
      expect({ file: relative, found }).toEqual({ file: relative, found: count });
    }
  });
});
