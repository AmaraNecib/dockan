# #244 — a ratchet for raw-`.trim()` blankness gates, then the conversions

- Tier: **High-assurance**. Justification: the conversions decide whether a
  mark-only (bidi-mark-only) numeric draft is treated as *blank* or *chosen* in
  money/stock readers — opening stock (failure mode 1: stock/avg cost), custom
  return cash and settle amounts (mode 2: total computed wrongly) and payment /
  debt previews (mode 3: debt direction). A wrong conversion records a number
  the owner never saw, so the tier follows the failure mode, not the diff size
  (`docs/engineering-workflow.md`). Recorded here as the brief requires.
- Base: `origin/develop` @ `746ff933753a0b409e96365080c91e3ef6efb5b6`. `git
  merge-base origin/develop HEAD` == base == HEAD (#243 squash for #238).
- Authority: commit only. This lane does **not** push, open a PR, merge or write
  `.agents/wisdom/`.

## Problem

#238 unified the *predicate* (`draftBlank`) at four sites, but left a
hand-maintained list of the remaining raw-`.trim()` blankness gates. That list
was found incomplete in review round 1 (*three* more real gates). A hand-written
enumeration cannot be trusted, and "did we get them all?" is unanswerable by
inspection. So the deliverable is the **ratchet**, not the conversions: a test
that scans the numeric-draft readers for raw-`.trim()` blankness gates and fails
on any gate that is not classified — either converted to `draftBlank`, or listed
with a written reason it must stay raw.

## The one invariant (unchanged from #238)

Blankness is decided once, by the same normalisation the reader uses. Unify the
*test*; preserve each site's *fallback* (#146: `cleared reads 0, digits read
their value, unreadable keeps the previous`).

## The ratchet

`apps/web/src/lib/blankness-ratchet.test.ts`:

- Scope = every non-test `apps/web/src/**/*.{ts,tsx}` that imports
  `amount-parse` / `numeric-input` (the numeric-draft reader surface), plus the
  two reader modules themselves. A new numeric reader in a new file imports a
  reader, so it is scanned with no test edit.
- A gate is a `X.trim()` compared to `""` (either operand order), or
  `X.trim().length` compared to `0`, or the two-step
  `const X = <expr>.trim(); … X === ""`. Receivers already normalised through
  `normalizeArabicIndicDigits` (or `draftBlank`) are **not** raw and are skipped
  — those readers need the normalised string.
- Signature = `file::<canonical gate text>`; comment text is stripped first so a
  docstring cannot create a gate.
- `CLASSIFIED` is the whole enumeration. Verdicts:
  - `raw` — the gate must stay a raw trim (non-numeric: name/reason/note/barcode/
    date, or a deliberate UX work-indicator). Asserted **present**.
  - `draftBlank` — the gate was converted. Asserted **absent**: re-introducing
    the raw trim (the mutation) reddens the ratchet.
  - A detected signature with no entry is **unclassified** → red.
- A synthetic-source test pins the scanner itself.

## Conversions (each with a discriminating test)

| site | file | raw gate today | after | fallback preserved |
| --- | --- | --- | --- | --- |
| `resolveOpeningStock` | `lib/numeric-input.ts` | `trimmed === ""` | `draftBlank(text)` | blank → 0 / required |
| `openingRowStatus` | `lib/supplier-opening-draft.ts` | `raw.trim() === ""` | `draftBlank(raw)` | blank → untouched |
| `newOpeningRowStatus` | `lib/supplier-opening-draft.ts` | `input.amount.trim() !== ""` | `!draftBlank(input.amount)` | blank amount → untouched/incomplete |
| `parseReturnQuantities` | `components/parties/supplier-return-draft.ts` | `trimmed === ""` | `draftBlank(draft)` | blank → line skipped |
| `parseCashBackDraft` | same | `trimmed === ""` | `draftBlank(draft)` | blank → 0 |
| `percentageEdited` clamp | `components/ui/amount-percentage-input.tsx` | `percentageDraft.trim() !== ""` | `!draftBlank(percentageDraft)` | mark-only → not >100 |
| `returnQuantityError` | `pages/invoice.tsx` | `trimmed === ""` | `draftBlank(draft)` | blank → not part of return |
| `customCashError` | `pages/invoice.tsx` | `trimmed === ""` | `draftBlank(draft)` | blank → all-debt |
| ReturnsPanel entered filter | `pages/invoice.tsx` | `(drafts[id] ?? "").trim() !== ""` | `!draftBlank(drafts[id] ?? "")` | blank → no line |
| items create threshold | `pages/items.tsx` | `thresholdText === ""` | `draftBlank(threshold)` | blank → the `5` default |
| items edit threshold | `pages/items.tsx` | `thresholdText !== "" && … === null` | `!draftBlank(draft.threshold) && …` | blank → leave alone |
| stock unit-cost gate | `pages/stock.tsx` | `unitCost.trim() !== ""` | `!draftBlank(unitCost)` | blank → no unit cost |
| customer settle message | `components/parties/customer-settle-panel.tsx` | `value.amount.trim() !== ""` | `!draftBlank(value.amount)` | blank → no message (still blocked) |
| supplier pay message | `components/parties/supplier-pay-panel.tsx` | `value.amount.trim() !== ""` | `!draftBlank(value.amount)` | blank → no message (still blocked) |
| supplier adjust message | `components/parties/supplier-adjust-panel.tsx` | `amountDraft.trim() === ""` | `draftBlank(amountDraft)` | blank → no message (still blocked) |
| supplier-return quantity invalid | `components/parties/supplier-return-panel.tsx` | `draft.trim() !== ""` | `!draftBlank(draft)` | blank → not a bad draft |

## Deliberately NOT converted (raw, with reasons)

- Text/date gates in scope: `name`, `reason`, `note(s)`, `barcode`,
  `counterpartyName`, `dateDraft`, query/search — a mark-only paste in a *text*
  field is real content, and a mark-only date draft is still unreadable. Blank
  text ≠ blank numeric.
- `sale.tsx` `draftDirty` numeric gates (`quick.fields.cost/sell`,
  `discountValue`, `payment.amount`): the unsaved-work indicator, not a value
  decision. A pasted mark is work the discard warning must keep; converting can
  only *remove* a warning, never change a recorded number.

## Finding beyond the brief's list

`sale.tsx`'s four `draftDirty` numeric gates are on neither the brief's list nor
the #238 list. The ratchet surfaces them; they are classified `raw` above with a
reason rather than silently ignored.

## Planned tests

- The ratchet (above) + its scanner self-test.
- Per pure site: a mark-only == blank case in the site's own suite
  (`numeric-input.test.ts`, `supplier-opening-draft.test.ts`,
  `supplier-return-draft.test.ts`, `amount-percentage-input.test.tsx`,
  `invoice.test.tsx`/`invoice-returns.test.tsx`), plus rows in the #238
  `draft-blankness.test.ts` table where the reader is a pure function.
- Per component gate: a rendered-test case (mark-only draft behaves like blank),
  in `items.test.tsx`, `stock.test.tsx`, `supplier-pay-panel.test.tsx`,
  `supplier-adjust-panel.test.tsx`, `supplier-return-panel.test.tsx`,
  `party-detail.test.tsx` (customer settle).
- One e2e spec only where a screen path is involved (the brief: not the full
  suite).
- Mutation proof per site: revert to the raw trim, run the ratchet, record the
  command and exit code in `.scratch/reviews/244/<sha>-test-audit.md`.

## Implementation risks

- **Behaviour drift in a money reader.** Converting a gate changes mark-only
  from a refusal to blank. Each conversion states its fallback in the table and
  is pinned by a mark-only == blank test.
- **Over-broad scanner.** A text gate wrongly converted would treat a real name
  as empty. The scope is the numeric-reader import surface and the classification
  names each raw gate; the scanner's NORM exclusion keeps normalised readers out.
- **False negatives in the scanner.** Only `=== ""`/`!== ""`/`length === 0` and
  the two-step form are matched. A future gate written another way is out of
  scope by construction; the scanner comment says so.

## Result

Two commits: `7f8f5c2` is the ratchet alone, green on the untouched tree (all 46
current gates classified `raw`); `390da2d` converts the 15 numeric sites, flips
those entries to `draftBlank`, and closes the review findings below.

## Review round 1 (independent lenses at `390da2d`)

Seven read-only sub-agents (debate critic + defender, test-audit edge/coverage/
quality, code-review standards + spec). Outcomes, all recorded in
`.scratch/reviews/244/390da2d-*.md`:

- **No blocker.** Every conversion preserves its fallback; the ratchet reddens on
  each reverted gate (11/11 files, exit 1).
- **Fixed:** the brief's single e2e spec (`tests/e2e/blankness-mark-only.spec.ts`,
  passes on the fix and fails on the revert) and its before/after screenshots;
  the `draftBlank` docstring over-scope (scoped + names the `sale.tsx`
  `draftDirty` exception); the scanner's undocumented syntactic ceiling (now a
  `KNOWN CEILING` note) and `?.trim()` support; synthetic self-tests for the
  reversed/`.length`/parenthesised/`?.` forms; mark-only pins for
  `parseSignedWholeNumber`, the threshold `"0"` boundary, a partial mark-only
  multi-line return, and an interior-mark settle refusal; the production
  `data-testid` was removed in favour of `input[name="itemThreshold"]`.
- **Documented, not hidden:** the scanner's scope hole (a numeric gate in a file
  that does not import a reader) and the signature collapse for two same-text
  gates in one file. `amount-percentage-input`'s conversion is outcome-neutral;
  the ratchet, not a black-box test, is its discriminator.

## Evidence

`.scratch/reviews/244/` at `390da2d`: `-debate.md`, `-test-audit.md`,
`-code-review.md`, `-mutation-proof.{sh,log}`, `-ratchet-green.log`,
`-ratchet-first-red.log`, `-mark-only-{broken,fixed}.png`.

## Review round 3 (four new Greptile findings on #246)

Findings 5-8 of that comment are the round-1/2 list re-listed and already
pinned; they are **not** reworked. Findings 1-4 are new.

- **1 — template expressions hid raw checks.** `stripComments` wanted a
  template to be text, so a comment inside `${}` survived and split the gate
  (`${draft.trim() /* blank */ === ""}`); `bracePairs` also skipped braces inside
  `${}`, while `collectDeclarations` read their declarations, so an inner
  normalised `trimmed` hid an outer raw `trimmed === ""`. Both passes now treat
  `${...}` as CODE, in one `scanSource` pass so the two agree by construction.
  Template *text* stays verbatim: blanking it would hide a real gate inside
  `${}`, the unsafe direction.
- **2 — a normalised key hid a raw value.** The `NORMALISED` skip tested the
  whole receiver, so `drafts[normalizeArabicIndicDigits(id)].trim()` was skipped
  even though only the key was normalised. `withoutSubscripts` strips `[...]`
  groups before the test, so the name; the selected draft is still raw and is
  reported. A normaliser over the value, or inside an argument, still skips.
- **3 — the proof harness accepted any non-zero exit.** Both scripts now require
  a GREEN unmutated baseline and the expected failing assertion (the ratchet) or
  at least one `(fail)` line (branch-pin); a crashed runner is refused.
  `proof-baseline-guard-demo.sh` demonstrates the old false pass and the new
  refusal on both scripts.
- **4 — the e2e asserted the form, not the stored value.** The spec now reloads
  and reopens the saved item, asserting `edit-threshold` reads `5`.

Failing-first: the three scanner fixtures fail on the pre-fix scanner with `[]`
(`ratchet-first-red.log`); the proof demo exits 1 on the old scripts with the
false pass shown and 0 on the new; `gate-set-diff` stays `ADDED []` / `REMOVED []`
(32 gates) against every earlier ref. Tier unchanged: High-assurance.
