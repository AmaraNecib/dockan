# #254 — money display: grouping, one currency placement, bidi isolation

Base: `origin/develop` @ `d843566` (no lane commits yet).

## Review tier

**Standard.** The diff renders existing integers differently; it moves no stored
value, no money arithmetic, no schema and no auth. The one new guard is a
source scan, not a money path.

## What the screenshot proves

`06-debts-92500-row.png`, cropped at 4× around the supplier row total, reads
left→right as `92500` `د.ج` `−`. Read the way an Arabic speaker reads the cell
(right to left) that is `−` `د.ج` `92500`: the sign has been bidi-displaced to
the far end of the row, away from the digits it belongs to, and the Arabic
currency sits between them. The same crop of the account-movements rows shows
`7500  د.ج  −` and `15000  د.ج  +`.

Cause, from the code:

- `apps/web/src/pages/debts.tsx:71` renders the sign as a bare string *outside*
  the amount: `{netBalance < 0 ? "− " : ""}<Amount value={Math.abs(...)} />`.
  In the RTL row the sign run is laid out first (rightmost) and the amount's
  LTR isolate to its left.
- `components/ui/amount.tsx` interpolates the raw number and keeps the currency
  inside the amount's own `dir="ltr"` span, so the digits are ungrouped and the
  currency is forced to the western side of the number.
- `pages/returns.tsx` and `pages/invoice.tsx:646` render money as raw
  `{value} {t("dzd")}` text, which in an RTL paragraph puts the currency on the
  *other* side of the number than `<Amount>` does — two currency placements on
  screen. Those sites are also ungrouped and unisolated.
- `lib/print-format.ts` already formats grouped Western digits for paper
  (`Intl.NumberFormat("en-US")`) and its own sheet pins the currency to the
  other side again.

## Decision: the one currency placement is the printed-sheet one

The amount's digits are isolated LTR, then a real space, then the currency as
its own RTL run. In an RTL page that draws the currency to the **left** of the
number — the order the paper sheet already uses and already pins in
`tests/e2e/invoice-print-a4.spec.ts:247-253`.

Reasons, in order of weight:

1. It is the only placement with an existing, deliberate, e2e-pinned decision
   behind it (#121, `print-sheet.tsx` docstring + `receipt-view.test.tsx`).
   Unifying here changes no pinned expectation; unifying on the screen's side
   would reverse a reviewed decision.
2. The currency is Arabic text. Keeping it inside the amount's LTR isolate is
   what forces the western order and is the thing #166's `.cell-ltr` wisdom
   warns about: isolate the *digit run*, never the Arabic around it.
3. It is the placement that makes the sign safe, since the sign now lives
   inside the same isolate as its digits.

Reversible cheaply: it is one component (`components/ui/amount.tsx`).

**Left alone, per the scope guard:** whether a supplier balance shows a sign at
all, and what green means — the owner decision recorded in
`D:/projects/mani-project/.scratch/notes/decisions-money-ar.html` (the MAIN repo;
`.scratch/notes/` does not exist inside a worktree). The `− ` / `+` characters,
the `text-success` condition and every label are unchanged.

## Interfaces

```ts
// lib/money-format.ts — the one whole-DZD formatter (was lib/print-format.ts)
export function formatMoney(value: number): string; // 1234567 -> "1,234,567"

// components/ui/amount.tsx
export function Money(props: {
  value: number;
  /** a ledger sign (`+` / `−`) rendered INSIDE the isolate, next to its digits */
  sign?: "+" | "−";
  amountClassName?: string;
  currencyClassName?: string;
}): JSX.Element;

/** the screen default: uses Money with mono tabular figures */
export function Amount(props: { value: number; sign?: "+" | "−"; className?: string }): JSX.Element;
```

The two runs carry `data-testid="money-figures"` and `money-currency` — a
stable hook for the real-browser geometry check.

`PrintAmount` becomes `Money` with the sheet's own classes, so paper and screen
cannot drift again. The `dzd` i18n key is deleted; `currencyDinar` is the only
currency string.

## Planned tests

- `lib/money-format.test.ts` — grouping, zeros, negatives (absorbs the old
  `print-format.test.ts`).
- `components/ui/amount.test.tsx` — the rendered DOM: digits grouped, sign
  inside the isolate, currency a sibling after a real space, `dir="ltr"` on the
  figures only.
- `pages/debts.test.tsx` — the acceptance: a supplier row's rendered string for
  a **positive** and a **negative** account balance.
- Source guard (in `amount.test.tsx`) — no non-test `.tsx` may render the
  currency itself: the only file allowed to read `currencyDinar` is the money
  primitive.
- `tests/e2e/debts.spec.ts` — grouped digits on screen, and the real-browser
  bidi check (the currency's right edge sits left of the figures' left edge),
  the same shape the print spec already uses.

## Risks

- Grouping changes every rendered money string with ≥ 4 digits, so unit and e2e
  assertions that pinned `1500 دج` must move to `1,500 دج`.
- The screen currency side flips. Visual, so the lane leaves before/after
  images and a video at real user pace.
- `Intl.NumberFormat.format` takes `number`; `pages/reports.tsx` passed
  `"-" + n` strings and now passes numbers.

## Evidence (#259)

### Failing first, on the untouched app

- `tests/e2e/debts.spec.ts:97` — `toContainText("1,500 دج")`, base rendered
  `1500 دج`.
- `tests/e2e/supplier-adjustment.spec.ts:127` — `toHaveText("5,000 دج")`, base
  rendered `5000 دج`.
- the acceptance unit test, with `formatMoney` ablated out of the primitive —
  `Expected: "92,500 دج"`, `Received: "92500 دج"`.

### Ablations (each guard must redden when its subject is removed)

1. **Currency placement.** Put both runs back inside one `dir="ltr"` wrapper —
   the pre-#254 shape, logical string unchanged — and the geometry guard fails:
   `expectCurrencyLeftOfFigures` (`tests/e2e/money-display-helpers.ts:17`, called
   from `debts.spec.ts:121`) `Expected: <= 257.328125`, `Received: 321.890625`:
   the currency's right edge sits 64.6 px *right* of the figures' left edge.
   The unit guard `isolates only the figures…` fails on the same patch.
2. **One currency placement.** Render `{amount} {t("currencyDinar")}` in
   `pages/reports.tsx` and the source guard fails with
   `offenders = ["pages/reports.tsx"]`.
3. **Grouping.** Replace `{formatMoney(value)}` with `{value}` and the
   acceptance test fails (`Expected: "92,500 دج"`, `Received: "92500 دج"`).

### Before / after, same e2e fixture, real browser

| | base | after |
| --- | --- | --- |
| row text | `1500 دج` | `1,500 دج` |
| row visual, left→right | `1500` `د.ج` | `د.ج` `1,500` |
| signed credit row visual | `92500` `د.ج` `−` | `د.ج` `− 100,000` |

Images and video: `.scratch/reviews/254/before/` (the issue's own audit image,
the base-app page, and the base-app recording) and `.scratch/reviews/254/after/`
(the fixed page and the fixed recording).

## Decisions

- **One currency placement = the sheet's.** Digits isolated LTR, then the
  currency as the following RTL run. Reasons in "Decision" above. The screen's
  currency therefore moves to the left of the number; the sheet is unchanged.
- **The sign goes inside the isolate**, as a `sign` prop, so a ledger `+`/`−`
  cannot be displaced from its digits. The characters, the `text-success`
  condition and every label are unchanged.
- **`suffix` and the duplicate `dzd` key are gone.** `currencyDinar` is the only
  currency string, and `Money` is the only renderer — a source guard keeps it
  that way.
- **`playwright.config.ts` grows an env-gated video** (`E2E_VIDEO=1`), because
  the config deliberately had none and a visual change owes a recording. CI
  never sets it.
- **Two e2e-only helpers** (`shownAmount` in the expense spec, the geometry
  helper) keep the display rule in one place per spec instead of mirroring the
  formatter in every assertion.

## Left alone (scope guard)

The signed-green-number convention for a supplier balance: whether a sign shows
at all, what green means, and which phrase names a supplier receivable are the
owner's open decision. The card title, the summary wording and the movement
vocabulary are untouched.
