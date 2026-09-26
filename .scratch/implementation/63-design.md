# Issue #63 — i18n hygiene: remove hardcoded Arabic from production source

Tier: **Standard** (i18n refactor across api + web; no money-math or auth-logic change).

Base: `origin/develop` @ `a9d2bca` (branch `lane/i18n-hygiene`).

## Verified scope (corrected against the lane brief)

The brief's table is mostly right but mislabels two rows. Real survey of
Arabic in production source (excluding test files, `apps/web/src/lib/i18n.ts`,
and doc comments):

| file | Arabic code lines | reality |
|---|---|---|
| `apps/api/src/rpc/router.ts` | 16 | 14 activity summaries + correction prefix + withdrawal marker |
| `apps/api/src/store/drizzle-store.ts` | 8 | **seed category names** (7 expense defaults + `عام`), not "summaries" |
| `apps/api/src/auth/admin.ts` | 2 | default owner display name + password-reset summary |
| `apps/api/src/main.ts` | 1 | daily-backup summary |
| `apps/web/src/pages/reports.tsx` | 7 | literal `دج` (line 38 is a comment) |
| `apps/web/src/components/receipt-view.tsx` | 8 | literal `دج` |
| `apps/web/src/pages/invoice.tsx` | 6 | literal `دج` |
| `apps/web/src/pages/expenses.tsx` | 1 | literal `دج` |

Out of scope (confirmed): `i18n.ts` dictionary, `*.test.*` fixtures, Arabic in
doc comments (`schema.ts`, `packages/contracts/src/core.ts`,
`receipt-print.tsx`, `reports.tsx:38`).

Measured before: **49** production code lines with Arabic (16+8+2+1+7+8+6+1).

## Decisions

### 1. Activity summaries → locale-neutral tokens (no migration)

The returns feature already established the pattern: the api stores
`RETURN_RECORDED <rtn> <amount> <invoice> <debt>` and the web
`activitySummaryText()` renders it via i18n; unknown/legacy summaries fall
back to raw. We extend exactly that seam to every summary the api assembles.
No contract change (summary stays `string`) and no data migration: existing
Arabic rows keep rendering byte-for-byte as before, new rows render through
i18n. Mixed shapes are safe because the client renders both.

Token grammar: first whitespace token = tag, remaining fields positional with
the single free-text field last (`<name...>`), so embedded spaces are safe.

### 2. Correction reason prefix → new token + legacy dual-match

`CORRECTION_REASON_PREFIX` is read back to compute `priorNet` when a line is
corrected again. Rows already on disk carry `تصحيح فاتورة <inv> #<lineId>`.
New writes use `INVOICE_CORRECTION <inv> #<lineId>`; the read path matches
**both** prefixes (`isCorrectionReason`). Client `movementReasonText()` renders
the token; legacy Arabic rows fall through to raw (unchanged). This avoids a
data migration while never writing Arabic again.

### 3. Deferred (decision request)

- `drizzle-store.ts` seed category names (`عام`, 7 expense defaults) — these
  are **persisted data**, not assembled copy. Localizing seeded default names
  needs a data-model decision (localized defaults vs. key+translation) and a
  migration for existing DBs. A rename-only change would leave fresh installs
  in a token while existing DBs stay Arabic — a half-migrate. Deferred.
- `packages/contracts/src/core.ts`, `db/schema.ts` Arabic in comments — not
  user-visible; left alone per the brief.

## Planned tests

- api wire: settings summary is now `SETTINGS_UPDATED`; category/item/payment/
  expense summaries carry neutral tokens; legacy `تصحيح فاتورة` rows still
  count toward `priorNet`; new correction rows carry `INVOICE_CORRECTION`.
- web: existing `دج` assertions keep passing (Amount renders identical text);
  e2e activity assertions keep passing (i18n reproduces the Arabic output).
- `locale-neutral` guard: scan `main.ts`/`admin.ts` (now Arabic-free).

## Risks

- Space-splitting in `activitySummaryText` is fragile if a future field order
  changes; mitigated by free-text-last grammar.
- Empty owner `name` relies on the sidebar's existing `t("shellUser")`
  fallback (already in place). Verified `displayName()` + avatar handle it.
