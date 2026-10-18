# Issue #120 — Test-audit evidence

- **Audited code HEAD:** `5dbb6788a0a44de0365c86b4fb1c774d1dec160d`
- **Fix commit / evidence HEAD:** `a4647f53b6a616bebde58f65077768f63a52c144`
- **Base:** `8579fcf8f5d2197ec74d7fc01331530aef917957` (`origin/develop`)
- **Method:** three parallel read-only reviewer sub-agents — edge-case hunter,
  coverage analyst, quality reviewer — over the test files in
  `git diff 8579fcf...5dbb678` plus their source. Parent synthesized and fixed.

## Verdicts

- **Edge hunter:** no blocker; two real phone-identity bugs (separator-only
  phone becomes `""`; bidi/zero-width marks create phantom identities), plus
  identity/backfill edges.
- **Coverage analyst:** all three issue-mandated tests (identity/uniqueness,
  delete rule, picker→invoice→debts Playwright) present and strong; gaps
  concentrated in the page seam, the activity side-effect, and two
  backstop/over-claim spots.
- **Quality reviewer:** grade **B** — behaviour-first names, right seams,
  meaningful negative assertions; held back by mega-tests, duplicated web test
  scaffolding, two weak assertions, message-regex error matching, and the
  activity-row coverage gap.

## Synthesis — fixes applied in `a4647f5`

| Source | Finding | Decision |
|--------|---------|----------|
| Edge 1 | Separator-only phone (`"..."`, `" - "`) normalized to `""`, an empty-string identity the second walk-in collides on | **Fixed**: `normalizePartyPhone` returns `null` when the cleaned fallback is empty; store test proves two separator-only phones both store `null` |
| Edge 2 | Bidi/zero-width marks pasted from Arabic UIs (`\u200F0550…`) become a different identity | **Fixed**: strip `\u200B-\u200F \u202A-\u202E \u2066-\u2069 \uFEFF` before matching; store test proves `\u200F0550999888` → `+213550999888` |
| Edge 4 | A client could send a picked id with a contradicting typed name (debt groups under A, prints B) | **Fixed**: the resolved party's name is authoritative in `invoicesCreate`; router test asserts the override |
| Edge 5 / 8 | Backfill grouped by raw `TRIM` (double spaces, diacritics, case split one debtor) and could create NBSP-only parties | **Fixed**: groups raw names by `normalizeTextKey` (same key the picker uses), skips JS-whitespace-only names, updates every spelling in the group; new store test with 3 spellings → one party, 3 invoices |
| Edge 3 | Party-less, name-less credit invoice invisible to the debts aggregate | **Dismissed (pre-existing product behaviour)**: the sale form explicitly warns «سيُنشأ مبلغ متبقٍ غير منسوب»; typed-only/anonymous invoices are a supported contract path outside #120 |
| Edge 6 | Renaming leaves invoice snapshot names stale | **Dismissed**: `counterparty_name` is a historical snapshot by design; the party detail's invoice table has no name column, so no surface contradicts the header |
| Edge 7 | Kind-scoped count vs kind-agnostic delete (legacy wrong-role rows only) | **Dismissed**: router role validation makes the mismatch unreachable for new data |
| Edge 9 | Credit is clamped to 0 | **Dismissed**: documented degrade-over-crash choice |
| Edge 10 / Cov 4, 5, 6, 9 | Missing tests: whitespace phone, max length, cross-role delete, index backstop, activity rows, page dialog/supplier role, picker keyboard | **Fixed** (see below) |
| Cov 1 | Sale/purchase pages' `counterpartyId` wiring had no unit test | **Fixed**: sale-page test clicks a picker option and asserts `lastInvoiceInput.counterpartyId` |
| Cov 2 / Quality 9 | Party activity rows written but never asserted | **Fixed**: router test asserts `PARTY_CREATED/UPDATED/DELETED` summaries |
| Cov 3 | Partial unique phone index untested | **Fixed**: store test inserts a raw duplicate phone and expects `UNIQUE`, plus two NULL phones succeeding |
| Cov 7 | "diacritics" claim untested; landline fallback unasserted | **Fixed**: tashkeel query case; landline fixture in filter/owner tests; store landline test |
| Cov 8 | Backfill empty-name and post-marker rows untested | **Fixed**: NBSP-only name stays unlinked; post-marker invoice keeps a null id across a re-boot |
| Cov 10 | E2E never visited the supplier detail | **Fixed**: supplier detail assertions added |
| Quality 2 | Weak constant-echo supplier assertion | **Fixed** (`x.name`) |
| Quality 3 | Prefix assertion on joined payment invoice numbers | **Fixed**: exact sorted-set comparison |
| Quality 6 | Shadowed temp-dir variable in backfill tests | **Fixed**: `backfillDir` / `variantsDir` / `reuseDir` (and their cleanup calls) |
| Quality 1, 4, 5, 7, 8, 11 | Mega-tests, duplicated web mock scaffolding, divergent fixtures, timing waits, message-regex error assertions, monolithic e2e | **Deferred (not fixed)**: style/maintainability, not correctness; the shared store-DB tests make mechanical splitting riskier than the readability win. Recorded here and in the handoff as follow-up candidates |

## Post-fix gates (at `a4647f5`)

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 424 web tests + API suites pass (230 in the two touched API files)
- `bun run test:e2e` — 38/38 pass
