# #123 — one shared day-first DateField for the remaining range bounds

Tier: **Standard** (web UI). Base: `origin/develop` @ `da44b50` (merge-base = HEAD).

## Problem

`#119` replaced the expense **record** date field with a validated day-first text
field, but four native `<input type="datetime-local">` controls remain. They
render in the OS/browser locale — US month/day + AM/PM on the owner's Windows
build — which is the exact defect #119 describes:

- `apps/web/src/pages/expenses.tsx` — `expense-custom-from` / `expense-custom-to`
- `apps/web/src/pages/reports.tsx` — `report-custom-from` / `report-custom-to`

## Seam — `apps/web/src/components/ui/date-field.tsx` (new)

One component owns the control shape: a text `<input>` in the app's display
shape (`DD/MM/YYYY HH:mm`, Western digits, placeholder `01/10/2026 00:34`) plus
an **«الآن»** button. It reuses the existing seam rather than re-implementing
anything:

- `parseDateTimeText` / `nowDateTimeText` from `apps/web/src/lib/dates.ts`
- `inputClass` (`components/ui/input.tsx`), `Button`
- i18n `expenseDateHint` / `expenseDateInvalid` / `dateNow`

```ts
export interface DateFieldProps {
  id?: string;
  name?: string;
  /** controlled text, day-first: `DD/MM/YYYY HH:mm` */
  value: string;
  /** raw text on every edit and on «الآن» */
  onValueChange: (text: string) => void;
  testId: string;
  disabled?: boolean;
  /** a submit-time refusal the parent owns (the record form) */
  invalid?: boolean;
  /** id of the alert that carries that refusal; it must be in the DOM whenever
   * `invalid` is true, because the field then renders no node of its own */
  errorId?: string;
  /** cleared on a «الآن» click, after the value updates */
  onNow?: () => void;
}
```

The «الآن» and error testids are derived from `testId` (`${testId}-now`,
`${testId}-error`), so every caller gets them without a second prop.

Validation is the component's job: `unreadable = value.trim() !== "" &&
parseDateTimeText(value) === null`. Two display modes, because the two contexts
genuinely differ:

- **Controlled** (record form): the parent passes `invalid` + `errorId`; the
  field marks `aria-invalid` and points `aria-describedby` at the form-level
  `expense-error` alert it already renders. No second error node.
- **Uncontrolled** (range filters, which have no submit): the field derives its
  own inline `role="alert"` node (`${testId}-error`) from the value whenever it
  is unreadable and no keystroke is in flight, so a half-typed value is not
  scolded mid-keystroke. Because the refusal is derived, not a mount-local flag,
  an unreadable value the parent still holds keeps its warning across an
  unmount/remount (switching the range preset away and back). Typing a readable
  value clears it.

No `Date`, no `Intl`, no `dir` override — same bidi rules as #119.

## Adoption

| File | Control | testIds kept | Now testId |
|---|---|---|---|
| `expenses.tsx` | record date | `expense-date` | `expense-date-now` |
| `expenses.tsx` | custom from/to | `expense-custom-from` / `-to` | `…-now` |
| `reports.tsx` | custom from/to | `report-custom-from` / `-to` | `…-now` |

`withSeconds` is deleted from both pages. A range bound is now a `DateBound`
(`{ text, bound }`) folded by `editDateBound` in `lib/dates.ts`: empty opens the
bound, a readable moment sets it, and anything else (a half-typed or impossible
value) **keeps the previous bound**. That is what stops an existing range from
refetching the whole list unfiltered on every keystroke — a widening
`datetime-local` never produced. The bound the api receives is the same naive
ISO moment (`2020-01-01T00:00:00`) `datetime-local` + `withSeconds` produced.
The field's visible refusal, not a silent widening, says a value was not applied.
The pager is reset **only when the applied bound actually moves**: a refused or
half-typed edit keeps the previous bound and must not jump a later history page
back to page one.
The record form is unaffected: it keeps a plain text state and parses once at
submit.

Accepted, unchanged from the shared parser: a bare date is midnight (so a bare
`to` bound is the start of that day), and a reversed range is not refused
client-side — the api resolves the window.

## Round-trip

| typed | api input | old datetime-local |
|---|---|---|
| `01/01/2020 00:00` | `2020-01-01T00:00:00` | `2020-01-01T00:00:00` |
| `31/01/2020 23:59` | `2020-01-31T23:59:00` | `2020-01-31T23:59:00` |
| `` (empty) | `undefined` | `undefined` |
| `01/01/2020 0` (half-typed) | keeps the previous bound | n/a (old control could not emit it) |
| `31/02/2020 00:00` | keeps the previous bound + refusal | n/a (impossible) |

## Impossible calendar days

`parseDateTimeText` already rejects `29/02/2026` / `31/04/2026` in `develop`
(`isRealDate`, #119 follow-up @ `a0b9671`), pinned by
`apps/web/src/lib/dates.test.ts:125`. No change to the seam is needed; #123 only
relies on it and repeats the assertion at the field level.

## Tests

- `dates.test.ts` — pins the impossible-day refusal (#119 follow-up already in
  `develop` @ `a0b9671`) and the `editDateBound` fold (empty / readable /
  half-typed / impossible).
- `components/ui/date-field.test.tsx` (new) — `type="text"` + shared placeholder,
  `onValueChange` on edit, «الآن» writes a now-shaped value, refusal after blur
  with `aria-invalid`/own alert that survives an unmount/remount, controlled
  `invalid` + `errorId` wiring with no own node, disabled disables both.
- `pages/expenses.test.tsx` — custom bounds send the parsed ISO; an impossible
  bound shows the visible error and keeps the last applied bound; errors on both
  the `from` and `to` bounds; «الآن» fills and sends.
- `pages/reports.test.tsx` — CUSTOM reveals day-first text fields; parsed ISO in
  the query input; an impossible bound keeps the last applied window; «الآن» on
  the upper bound reaches the query.
- `tests/e2e/expense-reports.spec.ts` — backdated custom filter fills day-first
  and still returns the row; reports custom bound round-trips onto the period
  line; «الآن»; impossible-date refusal on both screens.

## Risks

- The filter refusal is derived from the value; only a keystroke in flight
  suppresses it, so the specs must blur (`.fill` then blur) to see it. A refused
  or half-typed edit keeps the last applied bound and does not reset the pager.
- RTL bidi can only be seen in a browser, not a unit test — the component keeps
  the #119 rule (plain text run, no `dir` forcing).
- `inputClass` now carries `aria-invalid:` border/ring tokens, so a raw input
  with `aria-invalid` turns red like the themed `Input` (the DateField fields
  included).
