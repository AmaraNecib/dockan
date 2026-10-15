# Code review — #198 at `699483d`

**Method:** `code-review` skill — Standards and Spec axes run as independent
read-only sub-agents against `git diff 21dbc13...HEAD` (base `21dbc13`), plus
the Standards smell baseline and the issue/design-doc spec.

## Standards axis

Standards sources read: `AGENTS.md`, `docs/engineering-workflow.md`,
`docs/development-workflow.md`, `docs/branch-workflow.md`, `CONTEXT.md`,
`oxlint.config.ts` (+ the anti-slop rules). No `CONTRIBUTING.md` exists.

No hard documented-standard violation. Checked specifically: the
anti-slop `no-object-parameters` rule bans the broad `object` keyword, not named
interfaces, so `firstCommitError(checks: CommitChecks<T>)` is legal; DoD #2
(E2E for user-facing flows), #3 (Arabic-first copy via i18next), #4 (no
generated artifacts) and "never `git add -A`" all hold.

| # | finding | severity | disposition |
|---|---|---|---|
| S1 | Duplicated Code: the `if (!paid.ok) throw ...` guard plus its 3-line comment was copy-pasted into both pages. | judgement | **Fixed** — `resolvedInitialPaid` holds it once, beside `firstCommitError` |
| S2 | Primitive Obsession / duplicated type: `discount?: { invalid; message }` and `payment: { invalid; message }` repeated one literal type. | judgement | **Fixed** — one named `Check` type |
| S3 | Commit subjects use `(#198)` where history uses `(closes #N)`. | judgement | **Dismissed** — the branch is squash-merged; the parent sets the PR subject; local commits only, no push |
| S4 | `firstCommitError` / `CommitChecks` naming vs the pages' `submit()`. | judgement | **Dismissed** — "commit" is this codebase's term for saving an invoice (`commitRef`, "a commit is in flight") |
| S5 | Hoisted test helpers use `!` where `saveButton` uses an explicit throw. | judgement | **Dismissed** — matches the surrounding helpers' pre-existing style |

Explicitly not smells: `firstCommitError` is not a Middle Man (it owns the
order); the optional `override`/`discount` slots are not Speculative Generality
(both callers exist); the diff *removes* Shotgun Surgery; layered lib/page/e2e
coverage is intentional, not duplicate code.

## Spec axis

Spec: issue #198 plus the brief's three asks and its constraints (preserve money
math, no server/contract/schema change, keep per-screen copy).

- **Ask 1 delivered.** `firstCommitError` owns the exact order
  (empty → party → per-line (override before quantity) → discount → payment)
  and both screens call it.
- **Ask 2 delivered.** override-vs-payment page test, quantity boundary on both
  screens, multi-line on both screens, plus a browser-level ordering assertion.
- **Ask 3 delivered and pinned** at lib, page, and E2E levels.

| # | finding | disposition |
|---|---|---|
| P1 | Point 3 is only fully satisfied for checkout: `parseWholeAmount` still rejects Arabic-Indic and backs supplier-return quantities. | **Recorded** — same deferred ticket as the debate F1; widening it would touch a frozen money reader |
| P2 | Scope creep: the `if (!paid.ok) throw` guard is new, unrequested, unreachable code. | **Accepted** — dead-but-loud defensive code protecting an invariant; consolidated into `resolvedInitialPaid` and unit-tested |
| P3 | The browser E2E exceeds the "page test" wording of ask 2. | **Accepted** — consistent with the High-assurance bar |

Verified correct, not wrong: money math and copy are byte-identical to base
(`initialPaid: resolvedInitialPaid(paid)` → the same number as `paid.paid`); the
discount predicate is the same expression merely hoisted; the ordering test
asserting `total === 13` while the override is invalid is exactly what makes the
payment-vs-total shadowing reachable (`Math.round(12.5) === 13`); no
server/contract/schema change.

## Round summary

Standards: 5 findings (2 fixed, 3 dismissed). Spec: 3 findings (1 recorded
deferred, 2 accepted scope notes), no missing ask.
