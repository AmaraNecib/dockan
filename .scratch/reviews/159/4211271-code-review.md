# Code review — #169 review-fix round (#159 / #160 / #166)

**Tier:** Standard
**Base:** `0b4ec68` (`origin/develop`)
**Reviewed delta:** `ec7f518..4211271` (PR #169 review-fix commit)
**Reviewed code:** `4211271`
**Gate artifact for HEAD:** the evidence commit that adds this file

Supersedes `ffde449-code-review.md` (the pre-Greptile pair is kept as history).

## Standards

Sources: `docs/engineering-workflow.md`, `docs/development-workflow.md`,
`AGENTS.md`, `oxlint.config.ts`.

- The P1 fix reuses the existing `debtOffsetDisplay` helper
  (`lib/return-voucher.ts`) — the same projection the voucher and the returns
  list use. One source of truth for the debt wording; no duplicated threshold
  logic. Fixes the round-1 "two sources of truth" smell rather than adding one.
- The P2 fix is a ref + effect with a consumed flag: no state write, no
  dependency churn, no focus on initial mount. Matches the existing
  `useRef`/`useEffect` patterns in the file.
- P3 replaces a tautological prefix assertion with a number identity check plus
  a second-return case; test quality strictly improves.
- `bun run lint` → 0 errors; `bun run typecheck` → 3 successful. No new smell.
- Judgement note: the shared `inputClass` / `<Input>` divergence from the
  original review is unchanged by this delta and remains accepted.

## Spec

Spec sources: PR #169 Greptile findings and the round brief.

- **P1** — the card now reads as awaiting acceptance for a fresh
  `PENDING_REVIEW` return («عند القبول») and as applied for an accepted one
  («مطبّق», with the actually-applied value). `cashPaidOut` and value render
  unchanged. Matches the brief's instruction to use `debtOffsetDisplay` and the
  helper's label keys.
- **P2** — `pmt-new` and `returns-new` focus the restored form's first enabled
  field. No focus is stolen on first mount.
- **P3** — the e2e captures the card's return number, asserts the voucher
  equals it, and records a second return to prove the correct one opens.
- Scope respected: only the three fixes; no change to `index.css`,
  `components/vault/*`, or `App.tsx`; `lib/i18n.ts` untouched.

## Gates

```
git diff ec7f518..4211271    # reviewed delta
bun run typecheck            # 3 successful
bun run lint                 # 0 errors
bun run test                 # 643 pass / 0 fail
bun run test:e2e             # 47 passed
```

**Summary:** Standards — no violation; the fix removes a duplicated source of
truth. Spec — all three findings fixed and independently verified. No blocker.
