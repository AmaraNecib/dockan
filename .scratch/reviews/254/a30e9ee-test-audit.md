# #254 — test audit (head `a30e9ee`, base `d843566`)

Three independent reviewers (standards, spec/acceptance, test quality) ran
read-only against the committed diff. Verdicts: 4 findings / 4 notes / 7
findings, none blocking. Every finding is dispositioned below.

## Findings acted on

| # | Finding (reviewer) | Disposition |
| --- | --- | --- |
| 1 | `<Amount value={-100} sign="−" />` renders `− -100`; no test guards it (test quality, 🟡) | **Fixed.** The primitive reads the magnitude when a `sign` is given. `amount.test.tsx` "reads the magnitude when a ledger sign is given, so a sign cannot double" pins both branches. |
| 2 | `formatMoney(-0)` renders `-0`; `reports.tsx` negates COGS so it is reachable (standards, note) | **Fixed.** Negative zero formats as `0`; `money-format.test.ts` "prints a negative zero as 0, never -0". |
| 3 | Fractions unpinned: `Intl`'s default is 3 decimals (test quality, 🟠) | **Pinned, not changed.** Amounts are whole DZD by contract, so the formatter is not a rounding gate. `money-format.test.ts` now states and pins what it does (`92,500.5`, `1,234.568`). |
| 4 | Top of the safe-integer range unpinned (test quality, 🟠) | **Pinned.** `Number.MAX_SAFE_INTEGER` groups exactly; `1_700_000_000_000` too. |
| 5 | The "PrintAmount's classes" test rendered `Money` by hand, so it could not catch `print-sheet.tsx` dropping its classes (test quality, 🟡) | **Fixed.** It renders the real `PrintAmount` and asserts both paper classes. |
| 6 | The geometry helper passes for a zero-width currency run (test quality, 🟡) | **Fixed.** Both runs must have a non-zero width. This is the helper the placement ablation trips. |
| 7 | The zero-net group assertion was `toContain("0")` (test quality, 🟡) | **Fixed.** It pins `0 دج`. |
| 8 | The currency span lost the figures' mono type (standards, 🟠) | **Fixed.** `Amount` passes the currency the same mono/tabular classes it had inside the old single span, so the placement is the only visual change. |

## Accepted, not changed (with reasons)

- **The source guard scans `.tsx` only, and bans a second currency render rather
  than a raw numeric interpolation** (test quality, 🟡; standards, note). Both
  are true and stated. `i18n.ts` legitimately holds the catalog string and is a
  `.ts`; a `.ts` helper that rendered the currency would escape the scan. A raw
  number with no currency is not a currency *placement* bug, which is what the
  guard is for. Recorded as residual risk rather than hidden.
- **The guard matches substrings, so prose naming the units would redden**
  (standards, note). That is the intended tripwire: it is cheap to rename the
  prose, and it is the only thing that keeps a second placement out.
- **`.scratch/reviews/254/` binaries** (standards, 🟡). The repo already commits
  screenshot evidence under `.scratch/reviews/` (issues 96, 244) and the brief
  requires a recording for a visual change. Trimmed to 736 KB: before/after
  PNGs plus one video, instead of three.

## Not reproduced

- **"Every amount goes through the formatter" is proven only for currency
  strings** (spec, note): every `Amount`/`PrintAmount` call site in
  `apps/web/src` was enumerated with one sweep and the raw `{value} {t("dzd")}`
  sites (`returns.tsx`, `invoice.tsx`) are gone; `supplier-opening-balance.tsx`
  already used `<Amount>` and is untouched.
