# #123 — debate evidence

HEAD reviewed: `82ee0aeda6680f7a19a088d3609fd5472b8eeb5a` (base `origin/develop` @ `da44b50`).
Tier: **Standard** — debate was run because the lane brief explicitly requires it.

Three adversarial rounds (7 read-only reviewers, then 3, then 3). No blocker was
ever found; the round-1 major was fixed and re-verified.

## Round 1 (HEAD `e8762bb`) — 7 reviewers

| # | Finding (critic) | Severity | Decision |
|---|---|---|---|
| 1 | `parseDateTimeText(text) ?? undefined` derived on mid-typing text: an incomplete value meant "no bound", so editing an existing range refetched the list/report **unfiltered** on every keystroke (new vs `datetime-local`) | 6 | **Fixed** — `editDateBound`/`DateBound`/`OPEN_BOUND` in `lib/dates.ts` keep the previous bound until the text is readable or empty |
| 2 | A bare date used as the `to` bound is midnight, silently dropping that day | 4 | Accepted — the shared parser's documented semantics; recorded in the design doc |
| 3 | Clicking «الآن» blurred the field and flashed a refusal for the value it was about to replace | 4 | **Fixed** — `onMouseDown` preventDefault on the button |
| 4 | The record form re-parses text the field already parsed | 4 | Accepted — the field emits text; the parent must parse to send ISO |
| 5 | RTL/bidi cannot be verified by a unit test | 4 | Accepted — browser-only; component keeps the #119 rule (plain run, no `dir`) |
| 6 | Instruction lives only in a placeholder (WCAG 3.3.2) | 3 | Accepted — pre-existing #119 pattern; real `<label htmlFor>` added here |
| 7 | `aria-invalid` was visually inert on `inputClass` | 3 | **Fixed** — `aria-invalid:border/ring` tokens added to `inputClass` |
| 8 | Refusal styling differed between the field and the form alert | 3 | **Fixed** — one shared refusal panel |
| 9 | Unused `className` prop; `testId`+`nowTestId` data clump | 2 | **Fixed** — `className` removed, `nowTestId` derived `${testId}-now` |
| 10 | `onNow` JSDoc described the wrong contract | 2 | **Fixed** — reworded |
| 11 | `errorId` invariant (alert must exist while `invalid`) was not enforced; the inline category-create path cleared `error` while `dateInvalid` stayed true → dangling `aria-describedby` | 5 | **Fixed** — `submitCategory` success clears both |
| 12 | «الآن» truncates seconds | 1 | Dismissed — the display shape is minute-precision; `withSeconds` also produced `:00` |

Defender: confirmed the seam reuse (no `Date`/`Intl`), the empty-vs-invalid split,
`<div>`+`htmlFor` over a wrapping label, and that deleting `withSeconds` is safe.

## Round 2 (HEAD `35d803f`) — re-review

Confirmed 1, 3, 8, 9, 10 fixed with tests. New items: duplicate `i18n` import in
`reports.test.tsx` (fixed), shared mutable `OPEN_BOUND` (froze it), sticky blur
flag scolded after the first blur (reset on edit), `to`-bound refusal untested
(added), reports «الآن» assertion shallow (strengthened), design doc stale
(refreshed).

## Round 3 (HEAD `5707a37`) — final

> "Ship it — no blocker and no new regression at `5707a37`; #123's contract
> (day-first text control, parsed ISO bounds, impossible-date refusal, kept
> testids, «الآن», RTL/i18n) is satisfied."

## Deferred / dismissed, with a path forward

- **RTL bidi has no automated assertion.** Bidi run order is not observable in
  happy-dom; the component keeps the #119 rule and the e2e checks the period
  line, not the field. Accepted for this lane.
- **Bare date as a `to` bound = midnight** and **reversed range** are the shared
  parser's / api's semantics, unchanged from `datetime-local`+`withSeconds`.
  Documented in `.scratch/implementation/123-design.md`.
- **Latent a11y nit:** the record `DateField` passes `errorId="expense-error"`
  even in the `categoryListEmpty` branch, which renders no `<form>`. No reachable
  trigger was found (the list cannot become empty through this change).
- **`inputClass` now carries `aria-invalid:` tokens globally** — intentional,
  aligns every raw input with the themed `Input`.
