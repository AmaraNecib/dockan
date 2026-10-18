# Debate — #198 at `cb01879` (High-assurance)

**Method:** `debate` skill — a harsh critic and a charitable defender ran as
independent read-only sub-agents against `git diff <base>...HEAD`, the full
changed files, `gh issue view 198`, and `.scratch/implementation/198-design.md`.

**Rebased:** the review originally ran against the pre-rebase head `699483d`
(base `21dbc13`). The branch was then rebased onto `origin/develop` @
`3c3abcf` (#184, #196). The rebase was clean — no conflict, no code change — so
the findings and dispositions below still apply to the rebased code `cb01879`.
Reviewed files: `apps/web/src/lib/invoice-draft.ts`,
`apps/web/src/lib/amount-parse.ts`, `apps/web/src/pages/sale.tsx`,
`apps/web/src/pages/purchase.tsx`.

## Critic (verbatim findings)

> **Verified clean.** Order, message, and payload are byte-identical on both
> screens. Old sale: empty → party → per-line (override→quantity) → discount →
> payment; the helper reproduces it stage for stage, and purchase passes no
> `override`/`discount` so its old 4-stage order is unchanged. Eager
> `resolveInitialPaid` / discount-predicate moves are inert. Normalize-before-
> trim is inert; the cap still applies post-normalization; `\d` is ASCII-only
> under `/u`. Quantity inputs are `inputMode="numeric"` text inputs, so
> Arabic-Indic genuinely reaches the reader. No severity ≥ 8 blocker.

| # | finding | sev | disposition |
|---|---|---|---|
| F1 | The "one normalizer" claim was false: `parseWholeAmount` stays ASCII-only and backs two supplier-return quantity fields (`supplier-return-draft.ts:26`, `supplier-return-panel.tsx:102`). "Checkout quantities only" must be said out loud. | 5 | **Fixed** — `amount-parse.ts` docstring and design §4 name the covered readers; the supplier-return gap is a recorded follow-up |
| F2 | The sale price-override/discount readers stay ASCII-only while the quantity widens, and nothing pinned it; the new docstring invited the wrong assumption. | 5 | **Fixed** — a lib test pins the override reader and a sale page test pins the discount reader; the docstring now states the scope |
| F3 | The `paid.ok ? paid.paid : undefined` ternary traded a compile-time guarantee for a comment: a weakened payment slot could silently send no initial payment. | 3 | **Fixed** — `resolvedInitialPaid` throws beside the helper, restoring narrowing and failing loudly |
| F4 | `CommitChecks` returns loose strings, so a copy/predicate pair could be swapped. | 3 | **Dismissed** — each message sits beside its own predicate; page tests pin the copy; a stage union would push copy back into the helper |
| F5 | Design §5 described the override test as a negative amount driving the total below zero; the implementation uses a fractional `12.5`. | 2 | **Fixed** — doc now matches the implemented fractional case |
| F6 | `normalizeArabicIndicDigits` also maps Extended Arabic-Indic; consider a rename. | 2 | **Dismissed** — both ranges are the Arabic-Indic family and the docstring names both |

## Defender (highlights)

> **D1 (9/10).** `firstCommitError` is genuinely deep: delete it and the five
> ordered stages plus the per-line loop reappear at both pages — exactly where
> #188 found the same bug twice. It reuses `firstLineError`, so multi-line
> messaging cannot drift either.
>
> **D2 (8/10).** A fixed-shape input beats a gate list, which would put the
> order back at the call sites. Optional `override`/`discount` encode screen
> capability, not per-line state.
>
> **D3 (9/10).** The order is provably preserved and per-stage message identity
> is unchanged because each screen supplies its own `t(...)` strings.
>
> **D4 (9/10).** Eager `resolveInitialPaid`/discount computation is pure, total,
> and hoisted within one synchronous `submit()`.
>
> **D6 (9/10).** The Arabic-Indic widening is a literal extraction of the
> replace chain already inside `parseGroupedAmount`; money math is untouched and
> the percentage reader stays frozen.
>
> **D7.** The `parseWholeAmount` gap is a real residual but out of #198's scope:
> fix the comment, file a follow-up, do not widen a frozen money reader.

## Synthesis

All Fast-fix findings (F1, F2, F3, F5) were applied and committed in `236fecd`;
F4 and F6 were considered and dismissed with the rationale above. The one
deferred item — `parseWholeAmount` (supplier-return quantities) still rejecting
Arabic-Indic digits — is recorded in design §9/§11 and needs its own ticket.

Evidence for the return on fixing: the F3 guard duplication was itself caught
again by the code-review axis and consolidated into `resolvedInitialPaid`
(`cb01879`).
