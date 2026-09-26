import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Locale-neutral guard: the api persists/returns STABLE KEYS and structured
 * tokens — never Arabic sentence literals; the web UI owns the copy via i18n
 * (`t()` keys in apps/web/src/lib/i18n.ts). This guard scans source files that
 * must stay free of Arabic characters, so a future edit cannot sneak a locale
 * literal back into the api or web code.
 *
 * Files with intentional Arabic are excluded:
 * - apps/web/src/lib/i18n.ts (the translation layer — Arabic by design)
 * - db/schema.ts, packages/contracts/src/core.ts (Arabic in doc comments only)
 * - rpc/router.ts (the LEGACY_CORRECTION_REASON_PREFIX read-path constant)
 * - store/drizzle-store.ts (persisted seed category names; see issue #63)
 * - pages/reports.tsx, pages/receipt-print.tsx (Arabic in doc comments only)
 * Test files carry Arabic fixtures and are out of scope.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../../");
const ARABIC = /[\u0600-\u06FF]/;

const LOCALE_NEUTRAL_FILES = [
  // returns feature (new files)
  "apps/api/src/lib/return-calculations.ts",
  "apps/web/src/lib/return-voucher.ts",
  "apps/web/src/components/return-voucher-view.tsx",
  "apps/web/src/pages/return-print.tsx",
  "apps/web/src/pages/returns.tsx",
  // issue #63 — api/web files whose Arabic moved to the i18n layer
  "apps/api/src/main.ts",
  "apps/api/src/auth/admin.ts",
  "apps/web/src/pages/activity.tsx",
  "apps/web/src/pages/stock.tsx",
  "apps/web/src/pages/invoice.tsx",
  "apps/web/src/pages/expenses.tsx",
  "apps/web/src/components/receipt-view.tsx",
];

describe("production source stays locale-neutral (no Arabic literals)", () => {
  for (const relative of LOCALE_NEUTRAL_FILES) {
    it(`${relative} contains no Arabic characters`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      const matched = source.split("\n").findIndex((line) => ARABIC.test(line));
      expect(matched, `Arabic literal on line ${matched + 1}`).toBe(-1);
    });
  }
});
