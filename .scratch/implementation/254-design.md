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

---

# Round 2 — Greptile's two findings on PR #263 (head `a8cb27f`)

Tier: **Standard** (display layer). No stored value, no money arithmetic, no
schema. Restated per `docs/engineering-workflow.md` so the choice sits next to
the verdict.

## Finding 1 — money assembled inside a translated sentence never reached the primitive

`activitySummaryText` interpolated raw digits into catalog sentences
(`تسجيل دفعة {{amount}} دج`), and `pmtExceedsRemaining` did the same with
`remaining`. A call-site source guard cannot see them: the call sites contain
only translation keys. On the activity screen the result was `5000 دج` sitting
beside grouped `Amount` output.

**Decision: `Trans` + the primitive, not a second formatter.** A first probe
(`bun run` on a throwaway `.tsx`) proved the two candidate mechanisms behave
differently on this stack:

```
Trans one component:  دفعة <b data-testid="money-figures">5,000</b> على INV-2
Trans two components: منه <b ...>5,000</b> خصم و<i data-testid="money-currency">دج</i> نقداً
t with React element:  "قيمة [object Object]"
```

So `i18n.t` stringifies a React element (the trap), and only `Trans` reaches the
primitive. Money sentences become `<money/>` component tags; the currency
literal leaves the catalog, so the digits **and** the currency come from
`Money`. `activitySummaryText` returns `React.ReactNode`.

**Scope of the fix.** Every `{{…}} دج` catalog entry except one is routed:
the nine `activitySummaryText` money keys (same function and same screen as the
finding), `pmtExceedsRemaining`, and the two returns notes
(`returnsDebtCapNote`, `returnsCashWarning`) — 12 of 13. `itemsProfitPerUnit` is
left raw and pinned by the new catalog guard: the same key doubles as a table
header with `profit: ""`, so routing it needs a separate header key (see
Deferred).

## Finding 2 — the caller's `className` reached the figures but not the currency

The pre-#254 `Amount` was one `dir="ltr"` span carrying the caller's class, so
`stock.tsx`'s `text-foreground` inside a `text-muted-foreground` paragraph
coloured digits **and** currency. After #254 the class landed on the figures run
only, so the currency inherited the muted paragraph colour. Fix: `Amount`
passes the caller's class to both runs (`amountClassName` and
`currencyClassName`).

Swept every `Amount`/`Money` call site: exactly one passes a `className` to the
primitive — `stock.tsx:144` (`text-foreground`) — and `PrintAmount` passes the
sheet's two classes directly to `Money`, which this change does not touch. So no
other call site depended on the narrower behaviour.

## Interfaces (round 2)

```tsx
// components/ui/amount.tsx — unchanged signature; className now reaches both runs
export function Amount(props: { value: number; sign?: "+" | "−"; className?: string }): JSX.Element;

// pages/activity.tsx — the return type widens so a sentence can carry <Amount>
export function activitySummaryText(t: TFunction, summary: string): React.ReactNode;
```

## Planned tests (round 2)

- `amount.test.tsx` — the caller's class lands on the currency too (finding 2).
- `amount.test.tsx` — a **catalog** guard: no `i18n.ts` entry may hold `دج` and a
  `{{placeholder}}` together (money built by a string template). Failing-first
  lists 13 keys; after the fix it pins the one documented deferral.
- `activity.test.tsx` — the live `activitySummaryText` output renders through the
  primitive, grouped.
- `invoice.test.tsx` — the live overpay path (`pmt-error`) groups the remaining.

## Deferred

- `itemsProfitPerUnit` — the same key is the items-table header with `profit: ""`;
routing it through the primitive needs a separate header key and a preview-test
rewrite. Pinned by the catalog guard, so it cannot be forgotten silently.

## Evidence (round 2)

Recorded in the commit body on the final HEAD: failing-first runs with the
failing assertion named, the red→green transition, the gate commands, and the
catalog sweep result.

---

# Round 3 — Greptile's findings on PR #263 (head `79d8c53`)

Tier: **Standard** (display layer). No stored value, no money arithmetic, no
schema. Restated per `docs/engineering-workflow.md`.

## Finding 3 (live) — the currency could wrap without its number

`Money` returned two sibling `<span>`s in a fragment. In
`pages/supplier-opening-balance.tsx:791` the primitive is a direct child of
`flex flex-wrap items-center gap-1`, so the two runs became two flex ITEMS and a
narrow row could push the currency onto the line below its digits.

**Decision: one RTL wrapper, `nowrap`, figures still the only LTR isolate.**
The wrapper makes the pair one flex item, so a row that cannot fit the amount
moves the whole amount down. `whitespace-nowrap` is what makes it *atomic*: a
flex item's min-content width is now the whole amount, so the split cannot come
back inside the wrapper. `dir="rtl"` on the wrapper keeps the pair's base
direction independent of whoever mounts it; the figures keep `dir="ltr"` and the
currency keeps no `dir`, so `expectCurrencyLeftOfFigures` and the printed sheet's
placement are unchanged.

## Finding 1 (partly live) — one translated sentence still owned its money

`itemsProfitPerUnit` was the round-2 deferral: `pages/items.tsx:561` rendered
`t("itemsProfitPerUnit", { profit })` — raw digits into a catalog string that
embedded `دج` — so the items form showed `12500 دج` while the same screen's
`<Amount>` output was grouped. The round-2 catalog guard pinned that key as the
one allowed offender, which is exactly why Greptile's finding stayed open.

**Decision: close the deferral instead of renewing it.** The key becomes
`"الربح لكل وحدة: <money/>"` and the form interpolates through `<Trans>` +
`<Amount>`, the same route the activity summaries use. The key doubled as the
products-table header (`profit: ""`, which rendered a dangling `:  دج`), so the
header gets its own key `itemsProfitPerUnitHeader` — that rename is required by
the change, not cosmetic. The catalog guard's allowed list is now empty, and its
non-vacuity proof moves from a live offender to a fixture line, so the guard
still fails when the detector stops matching.

Finding 2 (currency loses caller styling) is **refuted**: `79d8c53` already
passes the caller's class to both runs (`amount.tsx:71`
`currencyClassName={cn("font-mono tabular-nums", className)}`), the test
`amount.test.tsx` "applies the caller's className to the currency" pins it, and
GitHub marks the review thread outdated (`line: null`, `position: 1`).

## Planned tests (round 3)

- `amount.test.tsx` — both runs share one `dir="rtl"`, `whitespace-nowrap`
  wrapper, and it is the only element the caller's flex row sees.
- `amount.test.tsx` — catalog guard: zero offenders, non-vacuous on a fixture.
- `items.test.tsx` — the live preview renders a grouped `12,500` through
  `money-figures`; the column header carries no dangling amount unit.
- `tests/e2e/supplier-adjustment.spec.ts` — a narrow (390 px) row squeezed to
  the digits' own width still keeps the currency on the digits' line.
- `tests/e2e/items-categories.spec.ts` — the live preview groups a five-figure
  profit and renders the primitive's runs.

## Evidence (round 3)

Failing-first runs, the red→green transition, the ablations, the gate commands
and the before/after images and video are recorded in the commit body on the
final HEAD.
