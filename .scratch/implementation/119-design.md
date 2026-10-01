# #119 — owner-trial defects: date/time standard + mechanical UI fixes

Tier: **Standard**. Base: `origin/develop` @ 8579fcf (merge-base = HEAD).

## Scope of this lane

Date/time formatting seam + the mechanical UI defects listed in the brief. Not in scope:
customers/suppliers (lane 120), `receipt-print.tsx` / `return-print.tsx` (lane 121),
`package.json` / lockfiles (deps lane).

## The seam: `apps/web/src/lib/dates.ts`

The API stores **naive Algeria-local** strings with no timezone:

- `localDateTimeSchema`: `YYYY-MM-DDTHH:mm:ss` (`packages/contracts/src/core.ts:20`)
- `localDate`: `YYYY-MM-DD`
- `reportsProfit.range.from/to` and the expense-range custom bounds are `localDateTime`.

`Intl.DateTimeFormat` / `toLocale*` cannot be used: the machine locale decides the output, so
the same row renders US month/day on the owner's build and day/month in tests. The formatter
must be pure string work — deterministic and timezone-proof.

```ts
// The app's display shape: day-first, 24-hour, Western digits.
export function formatDate(iso: string): string;        // "2026-10-01"            -> "01/10/2026"
export function formatDateTime(iso: string): string;    // "2026-10-01T00:34:15"   -> "01/10/2026 00:34"
export function parseDateTimeText(text: string): string | null; // "01/10/2026 00:34" -> "2026-10-01T00:34:00"
export function nowDateTimeText(now?: Date): string;    // the «الآن» button value
```

Rules:

- One strict matcher for both formatters: `YYYY-MM-DD` optionally followed by `T` (or a space)
  and `HH:mm` with optional `:ss`. Field ranges are validated (month 1–12, day 1–31,
  hour 0–23, minute 0–59).
- **Invalid input is returned unchanged.** A display formatter must never crash a page or
  print "Invalid Date"; legacy/garbage rows stay visible exactly as stored.
- `formatDateTime` on a date-only value returns the day alone (no fabricated `00:00`).
- Seconds are dropped from display — they are never useful to the owner.
- `parseDateTimeText` is the inverse for the one editable date/time field: it accepts the
  display shape, optional leading zeros (`1/10/2026`, `0:34`), an optional time (midnight),
  and optional seconds. Anything else (including raw ISO) → `null` so the form can teach the
  shape instead of sending a value the API will reject.
- No `Date` parsing anywhere: `new Date("2026-10-01T00:34:15")` is device-local, which happens
  to match the app convention today but is a time bomb on a foreign machine.

### Why no `dir="ltr"` on the date cells

Short form `01/10/2026 00:34` is two EN runs (UAX#9 W4 folds `/` and `:` into the number run),
so inside an RTL cell the first run (date) is laid out on the right and the second (time) on
its left: **date on the right, time on the left**, exactly the owner's requirement. `dir="ltr"`
on the `<td>` breaks *both* things: it re-orders the string (date left, time right) and flips
`text-align: start` to the left, so the column's body no longer lines up with its header
(verified in the running app: `th` computed `text-align: right`, `td[dir=ltr]` computed
`text-align: start` → left).

## Adoption sites

The 8 raw renders named in the brief, plus the three same-class renders a repo-wide sweep
found (`receipt-view.tsx:38`, `invoice.tsx:546`, `dashboard.tsx:185` — date-only, no `T`, but
still the stored ISO shape). `dir="ltr"` comes off every one of them.

| File | Field | Formatter |
|---|---|---|
| `activity.tsx:116` | `entry.at` | `formatDateTime` |
| `receipt-view.tsx:38` / `:118` | `receipt.invoiceDate` / `payment.paidAt` | `formatDate` / `formatDateTime` |
| `debts.tsx:90` | `invoice.invoiceDate` | `formatDate` |
| `dashboard.tsx:185` / `:267` | `summary.day` / `invoice.invoiceDate` | `formatDate` |
| `expenses.tsx:495` | `entry.occurredAt` | `formatDateTime` |
| `invoice.tsx:112` / `:546` | `payment.paidAt` / `invoice.invoiceDate` | `formatDateTime` / `formatDate` |
| `invoices.tsx:123` | `invoice.invoiceDate` | `formatDate` |
| `stock.tsx:256` | `movement.occurredAt` | `formatDateTime` |

Not touched: `components/return-voucher-view.tsx` (only mounted by lane 121's
`return-print.tsx`) and the invoice-number cells (they are LTR runs with no digits/slashes
ordering problem; only their `dir` attribute made them left-aligned — removed there too).

## Expense date/time field (`expenses.tsx`)

`<input type="datetime-local">` renders in the OS locale (`10/01/2026 01:18 AM`), so it is
replaced by a text field in the app's shape plus an **«الآن»** button:

- value `formatDateTime`-shaped; placeholder `01/10/2026 00:34`; testid stays `expense-date`.
- submit parses with `parseDateTimeText`; empty = "not provided" (the API records now, as
  today); unparseable = `expenseDateInvalid` form error, nothing is sent.
- the button carries testid `expense-date-now` and writes `nowDateTimeText()`.

The two custom-range fields (`expense-custom-from/to`) and the reports page's custom bounds
stay native `datetime-local` for now — same defect class, not in this brief's item 3. Reported
as a follow-up.

## Reports period line (`reports.tsx`)

The old line was a wrapped Arabic sentence with `dayFormatter` (the app's last `Intl` use).
Replace with one nowrap line beside the select:

```
01/10/2026 — 31/10/2026
```

`data-testid="report-range-label"`, no `dir="ltr"` spans, no `Intl`.

## Mechanical fixes

- `stock.tsx` «رجوع للمنتجات» becomes `Button asChild variant="outline" size="sm"` wrapping the
  `Link`, with a lucide `ArrowRight` (RTL: back points right) before the label.
- `items.tsx` #7: the items-page form already ships the merged single-save flow with an
  initial-stock field that accepts `0` (`items.test.tsx` covers 0/blank/positive). The two
  buttons the issue quotes — «منتج جديد بدون مخزون» / «منتج جديد مع مخزون» — live on the sale
  quick-add (`sale.tsx`), so the fix lands there: one «منتج جديد» button, an always-visible
  «المخزون الأولي» field, blank or 0 = plain create, >0 = create-with-stock. The 7 e2e specs
  that clicked `sale-quick-stock-add` are updated to the single button.
- i18n: one contiguous `// issue #119` block in `apps/web/src/lib/i18n.ts`.

## Tests

- `apps/web/src/lib/dates.test.ts` — the `T`, optional seconds, date-only, midnight,
  invalid input, parse/format round-trip, fixed `now`.
- `apps/web/src/pages/expenses.test.tsx` — the record form sends the parsed ISO, rejects
  garbage, and «الآن» refills.
- `apps/web/src/pages/reports.test.tsx` — the short single-line label, no ISO leak.
- Playwright `tests/e2e/expense-reports.spec.ts` — the expense date field and the reports
  period line; the items/dates specs for the touched columns.

## Risks

- Bidi: verified in a running browser (date/time run order, `text-align` flip). A unit test
  cannot see bidi; the e2e reads `textContent` (logical order).
- The sale quick-add merge touches 7 shared e2e specs; lane 120's customers work may touch
  `sale.tsx` too (landing order is the parent's call).
- `823` granular tests assert old raw strings (`debts`, `invoice`, `receipt-view`,
  `dashboard`) — updated in the same commit.
