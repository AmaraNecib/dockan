# Issue #120 — Integration-round code-review evidence (post-rebase)

- **Reviewed integration HEAD:** `5c26a8a473cfab2a38a6b09d7dfbfb25580e539f`
- **Final code HEAD / this file:** `a8f02b9232616d31b3a7bf47286d1e4baef8b1cf`
- **Pre-rebase reviewed code:** `60573aff2bb896aac06ac84683924ec4b8d2e52b`
- **Rebased onto:** `origin/develop` @ `a0b96718f747d94181fc2b257d7d0ff2963a50b3`
- **Earlier review:** `.scratch/reviews/120/4cda79c-code-review.md` (Standards + Spec on the pre-rebase code)

## Standards axis (integration)

**Blocker — none.**

- No conflict-marker residue anywhere under `apps/ tests/ packages/`.
- No i18n duplicate keys; `saleQuickStockBtn` has zero references tree-wide.
- `activity.tsx` uses `formatDateTime` (moment) and drops the LTR wrapper, per
  the `lib/dates.ts` docstring.
- The rebase resolution merged both lanes' mock surfaces into one
  `mock.module("@/lib/rpc", …)` without collision.
- Residual (unchanged from the earlier round): `"Party"` is not a `CONTEXT.md`
  glossary term — deferred as a docs/ADR follow-up; thin role switches across
  web files — accepted adapter duplication.

## Spec axis (integration)

**Blocker — none.** All eight #120 scope items verified on the final tree
(RPC handlers, picker in sale + purchase, customers/suppliers pages, full-page
detail, phone uniqueness, backfill, Arabic-first i18n, «الطرف» retired — the
only remaining hits are test fixture names and the i18n guard test).

- **#119 date standard correctly applied** on the party detail: invoice date
  `formatDate` (`party-detail.tsx:45`), payment `formatDateTime` (`:59`),
  created-at `formatDateTime` (`:272`); all `TODO(dates)` markers and date-cell
  `dir="ltr"` wrappers removed. Surviving `dir="ltr"` cells are identifiers
  (invoice numbers, phone), which is correct.
- Open interpretation notes from the earlier round (role-split backfill,
  deliberate hardening scope, unguarded index at setup) are unchanged and
  recorded in the earlier evidence; none is a defect.

## Resolution in a8f02b9

| Finding | Action |
|---------|--------|
| Low: party-detail date wiring untested | **Fixed**: `parties.test.tsx` asserts the rendered day-first strings for the invoice, payment, and created-at cells |
| Everything else | No new findings requiring a fix |

## Executed gates at the final integration SHA

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 466 web tests + API suites pass
- `bun run test:e2e` — 38/38 pass (full suite)
