# Fix: from-only expense window must clamp to now, not year 9999

**Issue:** #54 (merge follow-up from #49 review). Tier: Standard. Base: 96afde9.

## Root cause

`resolveWindow` (apps/api/src/rpc/router.ts) resolves caller-supplied bounds with a
hardcoded upper sentinel:

```ts
const to = input.to ?? (input.from === undefined ? month.to : "9999-12-31T23:59:59");
```

A from-only `expensesList({ from })` therefore queries `[from, 9999-12-31]` and returns
future-dated expense rows. The documented contract (packages/contracts/src/core.ts,
`expenseListInputSchema` from/to note) already says from-only filters "up to now"; the code
violates it. The profit-report resolution path (`reportsProfit`) reaches the same resolver
through the CUSTOM preset: `customFrom` given without `customTo` currently resolves to an
empty upper bound and is rejected `INVALID_RANGE` — the wire cannot express a working
from-only report at all.

## Fix (half-open window resolution, pure + clock-injectable)

- **apps/api/src/lib/report-ranges.ts**
  - New pure helper `resolveBoundsWindow(from, to, now = new Date(), fallback = currentMonthRange(now))`:
    - absent lower bound → `0001-01-01T00:00:00` (beginning of records; unchanged to-only
      semantics, documented);
    - absent upper bound → `localDateTime(now)` (Algeria-local, same clock as report
      windows; replaces the 9999 sentinel);
    - both absent → fallback (current month);
    - both present → pass-through.
  - `preset: "CUSTOM"` on the result (bounds-only windows echo CUSTOM today).
  - Remove `validCustomRange` (its "both bounds required" contract is superseded by
    half-open resolution; only the router used it).
- **apps/api/src/rpc/router.ts** — `resolveWindow` restructured additively (same signature,
  same call sites):
  - one `new Date()` read per resolution;
  - `preset` defined and CUSTOM → explicit both-bounds-absent stays `INVALID_RANGE`;
    otherwise half-open via `resolveBoundsWindow`; disordered → `INVALID_RANGE`;
  - `preset` defined and non-CUSTOM → unchanged (`resolveReportRange`, presets own window);
  - no preset + ≥1 custom bound → half-open CUSTOM window (was `INVALID_RANGE` for
    single bound; now works — the from-only report path);
  - no preset + no custom → bare from/to half-open; neither bound → current month (unchanged).
  - A from-only window whose `from` lies in the future (> now) now fails `INVALID_RANGE`
    instead of silently returning future rows under 9999.
- **packages/contracts/src/core.ts** — update docstrings: CUSTOM pair is half-open with
  "at least one bound required" (profit + expense list inputs).
- No year-9999 sentinel remains anywhere in the query boundary.

## Tests

- Unit (report-ranges.test.ts, clock-injected, no sleeps):
  - from-only clamps to injected now (Algeria-local, incl. local-midnight hour-24 edge);
  - to-only opens at beginning of records;
  - both present pass through; both absent → fallback month;
  - idempotent: identical inputs+now → identical window.
- Router wire regressions (router.test.ts; synthetic `occurredAt` values 2020/far-future,
  deterministic against any real clock):
  - from-only expensesList excludes a 2099-dated expense, keeps a 2020 one;
  - from-only profit report (CUSTOM + customFrom only) excludes the 2099 expense,
    keeps the 2020 one (own category, byCategory total assertions);
  - to-only still open-ended (both rows inside a 2099 `to`); from+to exact window
    unchanged; explicit CUSTOM with no bounds still `INVALID_RANGE`;
  - future `from` (> now) → `INVALID_RANGE`.
- E2E: unchanged behavior per acceptance — existing suite must stay green; no new spec.

## Risks

- Single-bound CUSTOM (report) changes from `INVALID_RANGE` → working half-open window:
  a deliberate, documented extension required by the issue's "from-only profit-report"
  regression; no existing test pins the old rejection.
- Future-dated `from` now rejects instead of silently widening — tightening, matches the
  existing "ordered bounds" rejection policy.