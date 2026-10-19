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
 *
 * ADR-0008 §4.6 (round 6) — the vault follows the same rule: the API returns
 * stable VAULT_* codes and the web translates them through i18n.ts. The one
 * exception is the standalone pre-boot pages (schema-refusal.ts and
 * vault/lock.ts), which render before the web bundle exists and therefore have
 * no i18n runtime; their embedded Arabic is allow-listed by line below.
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
  {
    file: "apps/api/src/lib/schema-refusal.ts",
    reason: "standalone pre-boot page: served before the web bundle, so its copy is embedded in SCHEMA_REFUSAL_PAGE_COPY",
    pattern: /^\s+(title|heading|hint|messageTemplate): /,
  },
  {
    file: "apps/api/src/lib/vault/lock.ts",
    reason: "standalone pre-boot lock-refusal page: served before the web bundle, so its copy is embedded in VAULT_LOCK_PAGE_COPY",
    pattern: /^\s+(title|heading|hint|staleHint|fallbackHost|unknownOwner|ownerTemplate|staleOwnerTemplate): /,
  },
];

const allowedPatternsFor = (relative: string): RegExp[] =>
  ALLOWED_ARABIC.filter((entry) => entry.file === relative).map((entry) => entry.pattern);

/** Index of the first Arabic line no allow-list pattern excuses, or -1. */
const findViolation = (source: string, allowed: RegExp[]): number =>
  source.split("\n").findIndex((line) => ARABIC.test(line) && !allowed.some((pattern) => pattern.test(line)));

const LOCALE_NEUTRAL_FILES = [
  // returns feature (new files)
  "apps/api/src/lib/return-calculations.ts",
  "apps/web/src/lib/return-voucher.ts",
  "apps/web/src/components/return-voucher-view.tsx",
  "apps/web/src/pages/return-print.tsx",
  "apps/web/src/pages/returns.tsx",
  // issue #63 — api/web files whose Arabic moved to the i18n layer
  "apps/api/src/main.ts",
  "apps/api/src/rpc/router.ts",
  "apps/web/src/pages/activity.tsx",
  "apps/web/src/pages/stock.tsx",
  "apps/web/src/pages/invoice.tsx",
  "apps/web/src/pages/expenses.tsx",
  "apps/web/src/components/receipt-view.tsx",
  // ADR-0008 §4.6 — the unified vault (round 6): the api owns stable codes,
  // the web owns copy; the two pre-boot pages are allow-listed above
  "apps/api/src/lib/schema-refusal.ts",
  "apps/api/src/lib/vault/backup.ts",
  "apps/api/src/lib/vault/core.ts",
  "apps/api/src/lib/vault/crypto.ts",
  "apps/api/src/lib/vault/format.ts",
  "apps/api/src/lib/vault/http.ts",
  "apps/api/src/lib/vault/lock.ts",
  "apps/api/src/lib/vault/manager.ts",
  "apps/web/src/App.tsx",
  "apps/web/src/components/vault/vault-gate.tsx",
  "apps/web/src/components/vault/vault-settings.tsx",
  "apps/web/src/lib/logout.ts",
  "apps/web/src/lib/vault-client.ts",
  "apps/web/src/pages/settings.tsx",
];

describe("production source stays locale-neutral (no Arabic literals)", () => {
  for (const relative of LOCALE_NEUTRAL_FILES) {
    it(`${relative} contains no Arabic characters`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      const allowed = allowedPatternsFor(relative);
      const matched = findViolation(source, allowed);
      expect(matched, `Arabic literal on line ${matched + 1}`).toBe(-1);
    });
  }

  it("fails on a new Arabic literal in a scanned file and passes the allow-listed pre-boot copy", () => {
    const lockAllowList = allowedPatternsFor("apps/api/src/lib/vault/lock.ts");
    // a fresh display literal in a vault api file is a violation
    expect(findViolation('const message = "كلمة المرور غير صحيحة";', [])).toBe(0);
    // the embedded pre-boot page copy is exactly what the allow-list permits
    expect(findViolation('  heading: "البيانات قيد الاستعمال",', lockAllowList)).toBe(-1);
    expect(findViolation('  randomArabic: "مرحبا",', lockAllowList)).toBe(0);
  });
});
