# #257 round 5 — test audit

Provenance: the audit was performed by an independent reviewer sub-agent
(read-only) on the tree at `5c19b2f`. The two Medium findings it raised were
dispositions in `a9b6f6d`; this file is named for the head the lane reports, and
every claim below states which SHA it holds for. No gate here is inherited
unrun: the re-run commands and exit codes are in the response section.

Issue: #257 · PR #266 · base `2b5504ae` · reviewed `5c19b2f` · response `a9b6f6d`

## Reviewer verdict (on `5c19b2f`)

**PASS — both acceptance criteria hold, no blockers.** 2 amber, 3 yellow, no
vacuous assertions found.

Verified by reading the lines, not the comments:

- **AC1 (cancel during a pending save must not strand focus).** The effect
  redirects the caret when its named target cannot take focus; the lines table is
  `tabIndex={-1}`; the unit test asserts `document.activeElement` is *not* the
  body and *is* `[data-testid="purchase-lines"]`; the e2e asserts
  `toBeFocused()` in a real browser.
- **AC2 (no timer-dependent assertion left).** No `setTimeout`, `waitForTimeout`
  or fixed-sleep assertion in `tests/e2e/purchase-inline-product.spec.ts`. The
  hold is a promise gate resolved in a `finally`.
- **The gate is non-vacuous**: `expect(routePending).toBe(true)` runs *after* the
  freeze/cancel assertions, so it proves the request was still held while they
  ran.
- **The frozen-path premise is asserted, not assumed**: the test fails loudly if
  a future change re-enables the trigger, so it cannot rot into passing without
  exercising the redirect.
- **No duplicate coverage** between the unit and e2e layers; they are
  complementary (jsdom + gated promise vs real browser + route gate).

## Findings and dispositions

| # | severity | finding | disposition |
|---|----------|---------|-------------|
| F1 | amber | Focus after a *successful* save still lands on `document.body` (the success card replaces the whole draft) — same class, out of scope, and no test asserts the post-save caret. | **Deferred, documented.** `a9b6f6d-evidence.md` → "Observed, not fixed". It is the page's existing save-completed swap for purchase and sale alike and is not one of the two listed comments; the parent decides whether to open a follow-up. |
| F2 | amber | The `kind === "quantity"` and `target === undefined` redirect branches have no test. | **Dismissed, with reason.** No red path exists to construct: `pickItem` and `submitLineCreate` both refuse while `savePending`, and the paths that remove a line clear the draft in the same commit. The branches are a belt behind guards that already refuse at their entry points. Recorded as a deliberate widening in `.scratch/implementation/257-round5-design.md`. |
| F3 | yellow | `expect(document.activeElement).not.toBe(document.body)` is subsumed by the following `.toBe(linesRegion)`. | **Kept on purpose.** It names the failure mode the ticket is about; its message ("Expected: not HTMLBodyElement") is the one the ablation log carries. |
| F4 | yellow | The e2e title still read "(#257 round 4)" while the test now covers the round-5 cancel leg. | **Fixed** in `a9b6f6d` → "the frozen draft and the cancel that outlives it (#257 rounds 4-5)". |
| F5 | yellow | A comment claimed "nothing here moves the caret a second time" with no assertion behind it. | **Fixed** in `a9b6f6d`: the comment now states the fact (the region unmounts with the draft and the caret falls back to the document — the page's own save-completed swap) instead of claiming an unverified invariant. |

## Response gates (run on `a9b6f6d`, the committed tree)

| command | exit |
|---------|------|
| `cd apps/web && bun run test -- purchase.test.tsx` | 0 — 51 pass, 0 fail (`275 expect() calls`, up from 273: the two new a11y assertions) |
| `bun run test` | 0 — 4/4 turbo tasks; web 1335 pass, api 950 pass, desktop 68 pass, e2e-support, all `0 fail` |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun run test:e2e -- purchase-inline-product.spec.ts` | 0 — 3 passed |
| ablation A1 re-run on the current effect | 1 — red, as designed (`.scratch/reviews/257/r5-ablation-a1.log`) |

Logs: `r5-test-all.log`, `r5-typecheck.log`, `r5-lint.log`, `r5-e2e-green.log`.
