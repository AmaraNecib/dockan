import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Locale-neutral guard for the returns feature. The api persists/returns
 * STABLE KEYS and structured tokens — never Arabic sentence literals; the web
 * UI owns the copy via i18n (`t()` keys in apps/web/src/lib/i18n.ts). This
 * guard scans every NEW source file this feature added (api seam + web
 * components/pages) for Arabic characters, so a future edit cannot sneak a
 * locale literal back into the api or web code. Existing files the feature
 * edits (router.ts, invoice.tsx, ...) carry pre-feature Arabic elsewhere and
 * are covered by wire tests asserting the key-based strings actually emitted.
 *
 * i18n values (apps/web/src/lib/i18n.ts) are Arabic BY DESIGN and are
 * excluded — they are the translation layer.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../../");
const ARABIC = /[\u0600-\u06FF]/;

const NEW_SOURCE_FILES = [
  "apps/api/src/lib/return-calculations.ts",
  "apps/web/src/lib/return-voucher.ts",
  "apps/web/src/components/return-voucher-view.tsx",
  "apps/web/src/pages/return-print.tsx",
  "apps/web/src/pages/returns.tsx",
];

describe("returns feature stays locale-neutral (no Arabic in new api/web source)", () => {
  for (const relative of NEW_SOURCE_FILES) {
    it(`${relative} contains no Arabic characters`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      const matched = source.split("\n").findIndex((line) => ARABIC.test(line));
      expect(matched, `Arabic literal on line ${matched + 1}`).toBe(-1);
    });
  }
});