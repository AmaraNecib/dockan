# Code review (final delta) — #171 review-fix round 2

- PR base (fixed point): `54a754b`
- Delta base: `38e3fa5`
- Fix commits: `7e110cf`, `7ffd272`, `25fd822`
- Final evidence SHA: `dbbb0be5`
- Tier: High-assurance

Standards and Spec reviewers ran on the fix commits. Findings are kept separate.

## Standards

**Hard violations: none.** oxlint and tsc are clean; the diff is source/test
only; the source-only staging policy was followed.

Judgement calls:

| Finding | Disposition |
|---|---|
| The source-tracked relink now exists in five places (sale, purchase, ReturnsPanel, PaymentPanel, CustomerSettlePanel), with two implementations (dep-list + separate setters vs the functional updater used by the two new copies). | **Deferred** — a shared `useLinkedReference` hook would collapse them; out of scope for this review-fix round. |
| `useRef<"amount" \| "percentage" \| null>` is re-declared at five sites. | **Deferred** — export an `AmountPercentageSource` type as a tidy. |
| `clearPurchaseRecorder()` exists to defeat TS narrowing. | **Accepted** — documented; a capture-array would also work. |
| The functional updater reads a ref inside a `setState` updater. | **Accepted** — idempotent; the ref is written synchronously in `onChange` before `setValue`, so the updater sees the freshest source. |
| `key={invoice.id}` on PaymentPanel. | **Kept** — reseeds the pair per entity while the relink effect owns same-entity reference changes; now tested with a cached target. |

## Spec

Requirements verified:

1. PaymentPanel + CustomerSettlePanel source-tracked relink — yes (untouched
   follows, edited amount stays, edited percentage rescales, reference→0
   handled).
2. ReturnsPanel deliberately unchanged — confirmed (`git diff` touches no
   ReturnsPanel hunk).
3. Vacuous purchase test fixed — yes (`clearPurchaseRecorder` before the second
   save).
4. Tests for reference change under untouched/edited-amount/edited-percentage —
   yes, for both panels, plus the edge branches.
5. Guard 1+2 — re-run green (below).
6. Evidence regenerated at the new SHA — this file.

Beyond the literal ask (documented): the explicit `percentageInvalid` guard in
PaymentPanel, `key={invoice.id}`, and the extra edge tests. All small and
consistent with the sibling settle panel.

Nothing partially fixed; nothing wrong.

## Guard 1 + 2 (final code SHA `25fd822`)

- `bun run typecheck` — exit 0
- `bun run lint` — exit 0
- `bun run test` — exit 0 (731 pass / 0 fail)
- `bunx playwright test` — exit 0 (49 passed / 0 failed)
- Working tree clean; evidence at `dbbb0be5`, diff to HEAD is `.scratch/` only.

Greptile CLI was not run in this lane (needs auth); the parent runs it on
landing.

## Verdict

Standards: no hard violations; two deferred cleanups. Spec: all requirements
met, ReturnsPanel untouched. No unresolved blocker.
