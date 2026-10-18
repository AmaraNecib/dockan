# Report windows over date-only records: pick a day granularity and own it

**Date:** 2026-08-25 · **Ticket:** 31 · **Area:** apps/api/src/lib/{report-ranges,profit-report}.ts, router resolveWindow

Issue 31 adds flexible profit-report windows (24H…CUSTOM) over two record kinds with
DIFFERENT timestamp resolution: expenses have full `YYYY-MM-DDTHH:mm:ss` instants, but sale
invoices only store a date-only `invoice_date`. Three lessons that generalize:

1. **Date-only fields force day-granular window edges.** A mid-day custom window can never
   slice a date-only invoice to the instant — the honest move is to bucket sales by whole
   boundary days, pin that behavior with a test ("counts sales by whole boundary day while
   expenses use exact instants"), and DISCLOSE it in the UI (a hint under the range label).
   Don't leave the mismatch invisible; the reviewer (debate sev-6) will find it.
2. **When a scheduler feeds both a pure module and raw SQL, keep the predicate byte-identical**
   (`slice(0,10)` in the pure filter ⇄ `substr(?,1,10)` in the adapter JOIN) and let the pure
   layer re-check what SQL already filtered — formula changes then can't silently widen a
   window.
3. **Window resolution belongs in ONE place.** `resolveWindow` (preset > custom bounds >
   from/to sentinels > current-month default) with a documented precedence ("preset wins") and
   NEVER silently dropping client bounds (customFrom/customTo without a preset must act as a
   CUSTOM window, else a client bug looks like success with wrong data). Test: adventure — the
   audit suite flags both the dropped-bounds bug and the half-open `0001-01-01`/`9999-12-31`
   sentinel semantics (documented in the contract docstring now).

## Rebase across a parallel merged lane (debts #46 landed mid-flight)

- `git rebase origin/develop` on a clean checkpoint; conflicts were all ADDITIVE (new describe
  blocks, nav links, routes). Splicing the conflict region programmatically dropped the debts
  describe's closing braces — after ANY scripted conflict resolution, run typecheck before
  continuing, and eyeball the seam (the `=======` marker can sit inside a block).
- Set `GIT_EDITOR=true` for `git rebase --continue` when no editor is configured (VS Code
  missing → "could not commit staged changes").
- Re-key evidence to the post-rebase head and re-run the FULL gate battery incl. e2e (debts +
  diagnostics specs now run in the same suite — 15/15).

## E2E native-select traps

- `<option>` elements are never "visible": `waitFor()`/`toBeVisible()` on options time out;
  read `getAttribute("value")` (auto-waits attached) or assert `toHaveCount`.
- `selectOption({ label })` requires an exact label — a category whose option text carries a
  badge suffix (`سحوبات المالك (سحب المالك)`) needs value-based selection.
- `expect.poll` + signed reads: report expense lines render with a leading `-`; parse with a
  magnitude helper or the sign pollutes baseline math.
- "First-time setup" in a shared-DB e2e suite: `authResetPassword` is idempotent, so ALWAYS
  run the setup path instead of peeking `isVisible()` (a race with React mount returned false
  and logged in against a DB with no admin → `UNEXPECTED`).