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
 * - store/drizzle-store.ts (persisted seed category names; see issue #63)
 * - pages/reports.tsx, pages/receipt-print.tsx (Arabic in doc comments only)
 * rpc/router.ts emits most of the activity tokens, so it is scanned rather than
 * excluded: only its LEGACY_CORRECTION_REASON_PREFIX line may carry Arabic, and
 * ALLOWED_ARABIC below is what permits it. Excluding the whole file would let a
 * new Arabic summary in the busiest emitter pass unnoticed.
 * Test files carry Arabic fixtures and are out of scope.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../../");
const ARABIC = /[\u0600-\u06FF]/;

/**
 * The only Arabic a scanned file may carry. Each entry states the reason it is
 * deliberate; any other Arabic on the line still fails the guard.
 */
const ALLOWED_ARABIC = [
  {
    file: "apps/api/src/rpc/router.ts",
    reason: "read-path matcher for corrections written before the neutral token",
    pattern: /^const LEGACY_CORRECTION_REASON_PREFIX = /,
  },
];

const allowedPatternsFor = (relative: string): RegExp[] =>
  ALLOWED_ARABIC.filter((entry) => entry.file === relative).map((entry) => entry.pattern);

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
  "apps/api/src/rpc/router.ts",
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
      const allowed = allowedPatternsFor(relative);
      const matched = source
        .split("\n")
        .findIndex((line) => ARABIC.test(line) && !allowed.some((pattern) => pattern.test(line)));
      expect(matched, `Arabic literal on line ${matched + 1}`).toBe(-1);
    });
  }
});
