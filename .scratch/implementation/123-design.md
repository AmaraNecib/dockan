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
  nowTestId: string;
  disabled?: boolean;
  className?: string;
  /** a submit-time refusal the parent owns (the record form) */
  invalid?: boolean;
  /** id of the alert that carries that refusal */
  errorId?: string;
  /** cleared on a «الآن» click, after the value updates */
  onNow?: () => void;
}
```

Validation is the component's job: `unreadable = value.trim() !== "" &&
parseDateTimeText(value) === null`. Two display modes, because the two contexts
genuinely differ:

- **Controlled** (record form): the parent passes `invalid` + `errorId`; the
  field marks `aria-invalid` and points `aria-describedby` at the form-level
  `expense-error` alert it already renders. No second error node.
- **Uncontrolled** (range filters, which have no submit): the field renders its
  own inline `role="alert"` node (`${testId}-error`) once the field has been
  blurred with an unreadable value, so a half-typed value is not scolded
  mid-keystroke. Typing a readable value clears it.

No `Date`, no `Intl`, no `dir` override — same bidi rules as #119.

## Adoption

| File | Control | testIds kept | Now testId |
|---|---|---|---|
| `expenses.tsx` | record date | `expense-date` | `expense-date-now` |
| `expenses.tsx` | custom from/to | `expense-custom-from` / `-to` | `…-now` |
| `reports.tsx` | custom from/to | `report-custom-from` / `-to` | `…-now` |

`withSeconds` is deleted from both pages. The bound sent to the api becomes
`parseDateTimeText(text) ?? undefined` — the same naive ISO moment
(`2020-01-01T00:00:00`) `datetime-local` + `withSeconds` produced. Empty and
unreadable both mean "open bound"; unreadable additionally shows the refusal.

## Round-trip

| typed | api input | old datetime-local |
|---|---|---|
| `01/01/2020 00:00` | `2020-01-01T00:00:00` | `2020-01-01T00:00:00` |
| `31/01/2020 23:59` | `2020-01-31T23:59:00` | `2020-01-31T23:59:00` |
| `` (empty) | `undefined` | `undefined` |
| `31/02/2020 00:00` | `undefined` + refusal | n/a (impossible) |

## Impossible calendar days

`parseDateTimeText` already rejects `29/02/2026` / `31/04/2026` in `develop`
(`isRealDate`, #119 follow-up @ `a0b9671`), pinned by
`apps/web/src/lib/dates.test.ts:125`. No change to the seam is needed; #123 only
relies on it and repeats the assertion at the field level.

## Tests

- `dates.test.ts` — unchanged; already pins the impossible-day refusal.
- `components/ui/date-field.test.tsx` (new) — `type="text"` + shared placeholder,
  `onValueChange` on edit, «الآن» writes a now-shaped value, uncontrolled
  refusal after blur with `aria-invalid`/own alert, controlled `invalid` +
  `errorId` wiring with no own node, disabled disables both.
- `pages/expenses.test.tsx` — custom bounds send the parsed ISO; an impossible
  bound shows the visible error and omits the bound; «الآن» fills.
- `pages/reports.test.tsx` — CUSTOM reveals day-first text fields; parsed ISO in
  the query input; an impossible bound shows the error and omits the bound.
- `tests/e2e/expense-reports.spec.ts` — backdated custom filter fills day-first
  and still returns the row; reports custom bound; «الآن»; impossible-date
  refusal on both screens.

## Risks

- The filter refusal is blur-based; the specs must blur (`.fill` then blur).
- RTL bidi can only be seen in a browser, not a unit test — the component keeps
  the #119 rule (plain text run, no `dir` forcing).
