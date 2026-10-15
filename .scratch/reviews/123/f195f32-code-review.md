# #123 — code-review evidence (review-fix round 1)

Final HEAD: `f195f324c6da6ba7daf6d0aa11bd16f08ce6f309`
Base: `origin/develop` @ `07ab23d561b59e4117846fb8bebbb3415533cc49`
Delta: `git diff f353b67..f195f32` (`.scratch/reviews/123/round1-delta-final.diff`)

Two axes, reviewed independently by read-only sub-agents, twice (round 1 at
`156a011`, round 2 at `d0e56e1`) plus a final pre-merge re-check at `f195f32`.

## Spec

Every requested item is implemented and tested:

- **Finding 1 — derived refusal.** `date-field.tsx:71`
  `refused = invalid === true || (errorId === undefined && !editing && unreadable)`;
  `editing` only suppresses while a keystroke is in flight, so mounting (not
  editing) restores the warning. Covered at component, page and browser level;
  the page test also asserts the applied bound never moved.
- **Finding 2 — reset only on an applied change.** `applyBoundEdit` compares
  `next.bound !== previous.bound`; the preset/sort selects and the active "all
  categories" pill early-return via `applyFilterChange` / a size guard. Covered
  for from, to, clear, and every same-value guard.
- **Finding 3 — min-w-0 + stacking.** `min-w-0` on the shared input; both pages
  use `grid grid-cols-1 gap-3 sm:grid-cols-2`. The e2e exercises `/expenses`
  and `/reports` at 420px.
- **Conditionals resolved correctly.** Reports does not share the reset callback
  (no pager), so no parity test is owed. The record field shares the `DateField`
  component and inherits `min-w-0`, but not the two-column wrapper.
- **Process.** Debate + test-audit + code-review re-run; Guard 1 + 2 on
  isolated ports; evidence regenerated at the final SHA; no push.

Scope creep: none material. The same-value guards are the class the brief asked
the critic to hunt for; the guard test and `applyFilterChange` extraction are
review follow-ups.

## Standards

- **Documented standards.** Anti-slop SAFETY comments on the new `as` assertions
  are present; `oxlint` and `tsc` are clean. Static Tailwind classes only.
- **Fowler baseline.** `Duplicated Code` on the three select guards → fixed by
  extracting `applyFilterChange`. `Data Clumps` on
  `applyBoundEdit(previous, text, setBound)` → accepted; the pair is the price
  of comparing before/after and the call sites are two. `Speculative Generality`
  → none. No hard violation found in any round.
- **Vercel React best-practices applied.** Interaction logic stays in event
  handlers (no effect for the reset); derived state (`unreadable`, `refused`) is
  computed during render; no components defined inside components; guards use
  early exits. `rerender-functional-setstate` does not apply here: the handler
  is inline and recreated each render, and each edit is one discrete,
  synchronously flushed event, so the closure is never stale — the assumption is
  documented in the code. `rendering-conditional-render` does not apply: both
  operands are booleans, so `&&` cannot render `0`/`NaN`.
- **Web Interface Guidelines / WCAG.** Labels point at the inputs; validation is
  inline with `role="alert"`, `aria-invalid`, `aria-describedby`; the flex child
  carries `min-w-0` (the guideline's own Content Handling rule); `«الآن»` is a
  real `<button>` so Enter/Space work. The error copy states the expected shape
  (`أدخل التاريخ والوقت بهذا الشكل: 01/10/2026 00:34`) — WCAG 3.3.3.

## Verdict

Final pass: **no blockers, no new regressions — ship it.** The remaining items
are accepted notes or deferred follow-ups, all listed in
`f195f32-debate.md`.
