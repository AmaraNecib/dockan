# RTL dates: `dir="ltr"` breaks alignment, not bidi isolation (#119)

**Date:** 2026-10-01 · **Ticket:** 119 · **Area:** apps/web date columns + the shared `lib/dates.ts`

The owner reported `رقم الفاتورة` / `التاريخ` as "misaligned". The cause was not markup
spacing: every one of those cells carried `dir="ltr"`. In an RTL table the body cells compute
`text-align: start` (they do not inherit the header row's `text-right`), and `dir="ltr"` makes
`start` resolve to **left** while every other cell stays right. Measured in the running app:

```
th  التاريخ    direction rtl  align right
td  dir="ltr"  direction ltr  align start   -> left-aligned body under a right-aligned header
```

The same attribute also reorders a date/time string: with `dir="ltr"` the whole row reads
date-left/time-right, the opposite of the owner's reading order.

**Always**: leave date cells un-isolated. Day-first shapes are bidi-safe:

- `01/10/2026` — `/` is CS between EN digits, so UAX#9 W4 folds it into **one** number run;
  it can never reverse segment order.
- `01/10/2026 00:34` — the space is a neutral between two EN runs; in an RTL cell the first
  run is laid out on the right and the second on its left. Date on the right, time on the
  left, which is exactly what the owner asked for. No `<span dir="ltr">` needed.

**Always**: verify bidi in a real browser. `textContent` and `innerText` return the *logical*
string, and happy-dom/jsdom have no layout, so neither unit nor DOM tests can catch a reversed
date. `Range.getClientRects()` on the cell's text node shows the visual runs — in our case
time at x≈1346, space at x≈1376, date at x≈1380 (date rightmost) — and
`getComputedStyle(td).textAlign` catches the alignment half.

**Always**: one formatter per app. `apps/web/src/lib/dates.ts` (`formatDate`,
`formatDateTime`, `parseDateTimeText`, `nowDateTimeText`) is pure string work; no `Date`
parsing, no `Intl`/`toLocale*`, invalid input returned unchanged. See
`../testing/real-clock-fixtures.md` for why locale-driven display
formatters are untestable across machines.

## A cell that needs LTR isolation: `.cell-ltr`, never `dir="ltr"` (#166)

**Date:** 2026-10-12 · **Ticket:** 166 · **Area:** `apps/web` table cells + `index.css`

The #119 fix removed `dir="ltr"` from date cells, but invoice numbers, phones,
references and printed quantities still need an LTR run *and* must stay under their
right-aligned RTL header. `dir="ltr"` on the cell cannot do both: it flips
`text-align: start` to the left edge to order the digits, which is the misalignment.

**Always**: for a `<td>`/`<TableCell>`, use the shared utility, not the attribute:

```css
.cell-ltr { direction: ltr; unicode-bidi: isolate; text-align: right; }
```

It is appended to `index.css` (unlayered, so it beats Tailwind's layered `text-start`).
Inline `<span dir="ltr">` runs (e.g. `<Amount>`) are still correct — a span does not
carry the cell's alignment.

**Always**: keep a source guard, not just a rendered test. `apps/web/src/lib/cell-ltr.test.ts`
scans every non-test `.tsx` for a cell carrying `dir="ltr"` (any quote spelling) and
pins the utility's CSS and per-file counts. A `<td dir="ltr">` regresses silently in
unit tests because happy-dom has no layout. The scan's `[^>]*?` cannot see past a `>`
inside a JSX attribute, so a cell with an inline arrow-function prop plus `dir="ltr"`
escapes it — do not reintroduce one.
