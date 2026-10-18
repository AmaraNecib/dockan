# From-only windows: absent upper bound clamps to now, never a 9999 sentinel

**Date:** 2026-08-26 · **Issue:** 54 · **Area:** apps/api/src/lib/report-ranges.ts + rpc/router.ts

A from-only `expensesList({ from })` leaked future-dated rows because `resolveWindow` filled
the absent `to` with `"9999-12-31T23:59:59"` instead of the contract's current-time boundary.
The contract docstring (expenseListInputSchema) already documented the intent — "from-only
filters up to 'now'" — the code just violated it.

**Always:**
- Resolve caller-supplied bounds through ONE pure, clock-injectable helper
  (`resolveBoundsWindow(from, to, now, fallback)` in report-ranges.ts) with half-open
  fillers: absent lower → `0001-01-01T00:00:00` ("beginning of records"), absent upper →
  `localDateTime(now)` (Algeria-local, the same clock the report windows use). One `now`
  per resolution; the router reads `new Date()` once and never sees sentinels.
- Keep the wire's boundary forms consistent: once `preset:"CUSTOM"` accepts a single custom
  bound, both directions are half-open (customTo-only opens at the beginning too) — a
  from-only report is only wire-expressible as `reportsProfit({ preset: "CUSTOM", customFrom })`
  because that schema has no bare from/to. Symmetry beats per-direction special cases.
- A future `from` (> now) now rejects `INVALID_RANGE`: clamping an absent upper bound makes
  the window [now-1…] contradictory. That tightening is a feature, pin it with a 2099-dated
  wire test (deterministic against any real clock).
- "No year-9999 sentinel in the query boundary" is a greppable acceptance: `rg 9999 apps packages`
  must only hit unrelated test literals (passwords, port numbers).