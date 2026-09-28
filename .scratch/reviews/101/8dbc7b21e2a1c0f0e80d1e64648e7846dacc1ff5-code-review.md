# #101 code review — head `8dbc7b21e2a1c0f0e80d1e64648e7846dacc1ff5`

Tier: Standard. Fixed point: `0b4d5a16c793cb775288fd576cddc3dcc62b7d24` (merge-base with `origin/develop`).
Diff: `git diff 0b4d5a1...8dbc7b2`. Commits: `6c706d7`, `241e40a`, `8dbc7b2`.

Two fresh sub-agents reviewed the diff on two axes. A first round ran at
`6c706d7`; this is the second round at the final head.

## Standards axis

Verified resolved from round 1:

- `index.css` defines `--destructive-foreground`, `--success`,
  `--success-foreground`, `--warning`; `git grep warning-foreground` → 0 hits.
  The unused/unreadable token is gone.
- `oxlint.config.ts` comments are self-contained (no pointer into gitignored
  `.scratch/`); the override names its scope and removal condition.
- Every added testid is consumed; no orphan testid.

Token pairing confirmed consistent: status tints carry
`text-warning`/`text-success`/`text-destructive` on `bg-*/10|20`; `*-foreground`
only on solid fills (`returns.tsx` accept/reject buttons).

Documented-standard violations remaining: none.

Baseline smells (judgement calls, non-blocking, deferred):

- *Duplicated Code* — each Select writes its option list twice (the Base UI
  `items` prop and the `SelectItem` children). This is the primitive's required
  shape, not a defect; a local helper would collapse three literals. Follow-up.
- The `items.tsx`/`stock.tsx` lint override has a removal note but no issue id.
  The sibling lane owns those files.

## Spec axis

Acceptance criteria:

1. No native `<select>` remains — **pass**; zero `<select>` elements in
   `apps/web/src` (the sole `grep` hit is a doc comment in the new test driver).
2. No raw palette/hex in scope, survivors documented — **pass**; only the
   sibling-lane files and the print-only hex remain, both in design doc §6.
3. `bun run lint` passes with the shadcn rules enabled — **pass** (ex 0).
4. Light and dark correct for every migrated control — **pass**; automated token
   contrast in both themes plus light/dark screenshots.
5. Keyboard/screen-reader unchanged or better — **pass**; Base UI combobox
   semantics, label/aria-label preserved, Escape test added.
6. `bun run test:e2e` passes — **pass** (26 passed, 1.6m).
7. `items.tsx`/`stock.tsx` untouched — **pass**; absent from the diff.
8. No hardcoded Arabic — **pass**; all `t(...)` keys.
9. Visual identity preserved, no behaviour change, same handlers/testids —
   **pass**; one documented dark-mode normalization (the fixed `green-700`
   accept button now follows the system's light-in-dark success accent).

Scope creep: none unjustified. `font-display`→`font-heading` (a dead class the
new rule caught), the `button.test.tsx` fixture, and the test-driver changes are
all consequences of enabling the rules and are documented.

Implemented-but-wrong: none found.

## Verdict

No blockers on either axis. Round-1 findings resolved; residuals are documented
follow-ups.
