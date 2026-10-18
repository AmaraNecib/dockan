# Code review — #169 review-fix round 2 (#159 / #160 / #166)

**Tier:** Standard
**Base:** `957d059` (`develop`, rebased; PR base `origin/develop`)
**Reviewed delta:** `a5020e5..0de82d3`
**Reviewed code:** the focus fixes at `d6ea827`; `0de82d3` corrects only their
comment
**Gate artifact for HEAD:** the evidence commit that adds this file

Supersedes `4211271-code-review.md` and `ffde449-code-review.md` (both kept as
history).

## Standards

Sources: `docs/engineering-workflow.md`, `docs/development-workflow.md`,
`AGENTS.md`, `oxlint.config.ts`.

- The fix adds one optional prop (`containerRef`) to the shared `SuccessCard`
  instead of a second wrapper element; the card stays a single focus target for
  every flow. No duplicated focus logic — both panels use the same
  ref + consumed-flag + effect shape already accepted in round 1.
- `tabIndex={-1}` keeps the card programmatic-only; it does not enter the tab
  order, so sale/purchase are unchanged.
- The fallback ref on the paid-off message is the smallest target that names the
  real state; no speculative generalization.
- `bun run lint` → 0 errors; `bun run typecheck` → 3 successful.
- Comment-accuracy note from the reviewers folded in (`0de82d3`).

## Spec

Spec sources: the Greptile round-2 findings and the round brief.

- **Finding 1** — on a successful save in `PaymentPanel` and `ReturnsPanel`,
  focus now lands on the completion card (which holds the completion actions),
  so a keyboard user who submits with Enter keeps their place.
- **Finding 2** — after the last payment clears the balance, `pmt-new` restores
  a form with every field disabled; focus now lands on the «مسدّدة بالكامل»
  message, and the pending flag is cleared only when focus actually moved.
- Scope respected: only the two focus fixes (+ the comment correction). No
  change to `index.css`, `components/vault/*`, `App.tsx`, or the lockfiles.
- The three stale re-printed Greptile items are already fixed in this tree and
  were not re-touched.

## Gates

```
git diff a5020e5..0de82d3     # reviewed delta
bun run typecheck             # 3 successful
bun run lint                  # 0 errors
bun run test                  # 658 pass / 0 fail
bun run test:e2e              # 48 passed
```

**Summary:** Standards — no violation. Spec — both round-2 findings fixed and
independently verified; mutation-checked tests. No blocker.
