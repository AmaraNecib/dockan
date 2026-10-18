# #254 — pre-push code review (head `a30e9ee`, base `d843566`)

Two read-only reviewers (standards; spec vs the brief's acceptance criteria and
SCOPE GUARD) ran against the committed diff. Verdicts: 4 findings / 4 notes and
4 findings / 0 blockers.

## What the reviewers confirmed

- **The sign/colour convention is untouched.** `debts.tsx:68` drives both
  `text-success` and the `sign` prop from the same `netBalance < 0` condition;
  the `− `/`+` characters, `Math.abs(displayAmount)`, the card titles and the
  movement vocabulary are identical. The scope guard holds.
- **Grouping and isolation land where the brief says.** One
  `Intl.NumberFormat` in the app (`lib/money-format.ts`); no `toLocaleString`
  anywhere; `amount.tsx` isolates the figures only, emits a real `{" "}` text
  node, and renders the currency as a separate RTL run.
- **The acceptance test exists** — `debts.test.tsx` pins `92,500 دج` and
  `− 92,500 دج` for a positive and a negative supplier balance, plus the figures
  run's own text.
- **The deletions are complete, not dead**: `formatPrintAmount`,
  `print-format.ts`, `t("dzd")` and `suffix=` have zero remaining references.
- **The paper DOM is unchanged**, which is why `receipt-view.test.tsx` and
  `invoice-print-a4.spec.ts:247` pass without edits.

## Findings acted on

| Finding | Disposition |
| --- | --- |
| `reports.tsx` `-0` on a zero COGS | Fixed in the formatter (`formatMoney(-0) === "0"`), pinned. |
| The currency span lost its mono type | Fixed: `Amount` keeps it. |
| The video knob in `playwright.config.ts` is #259 scope in a #254 diff | Fixed: the knob moved into the two specs that owe a recording; the config keeps a sentence naming the opt-in. |
| The print-classes test did not render `PrintAmount` | Fixed (see the test-audit file). |

## Accepted, not changed (with reasons)

- **The currency-placement interpretation.** The reviewer is right that the
  brief's "one currency placement" bullet is ambiguous, and that the chosen
  placement is the one the ticket quotes as the fault (`د.ج 7500`). It is still
  the only placement with an existing deliberate, e2e-pinned decision behind it
  (#121, `print-sheet.tsx` + `invoice-print-a4.spec.ts:247-253`), and the
  currency is Arabic text that should not be forced into the figures' LTR
  isolate. The screen's currency therefore moves to the left of the number.
  Reversible in one component — **flagged to the owner in the lane report.**
- **Evidence binaries under `.scratch/reviews/254/`.** The repo's own pattern
  (issues 96, 244) and the brief's visual-evidence rule; trimmed to 736 KB.
- **`captureEvidence` / `assertCurrencyLeftOfFigures` / `shownAmount` are not
  among the four allowed scope items.** They are the #259 evidence mechanism the
  standing rule requires for a visual change, and they are inert without
  `E2E_EVIDENCE_DIR`. No conflict with #260's files.

## Citation fixed

The design doc cited the owner-decision note without its path. It lives in the
MAIN repo, not a worktree:
`D:/projects/mani-project/.scratch/notes/decisions-money-ar.html`.
