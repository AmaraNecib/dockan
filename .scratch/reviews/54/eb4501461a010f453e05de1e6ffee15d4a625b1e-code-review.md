# Code review — from-only expense windows clamp to now (issue #54)

- **Final head reviewed:** eb4501461a010f453e05de1e6ffee15d4a625b1e
- **Base:** 96afde9 · diff `git diff 96afde9...HEAD` · commits d10bb98 + eb45014
- Two axes ran in parallel sub-agents (standards + spec); findings applied in eb45014.

## Standards

Repo standards: docs/engineering-workflow.md; .agents/wisdom/2026-08-25-report-windows-and-rebase.md
(window resolution in ONE place, documented precedence, pure clock-injectable helpers,
deterministic tests). Baseline Fowler smells applied as judgement calls; tooling-enforced
rules skipped.

**Compliant (verified):**
- `resolveBoundsWindow(from, to, now, fallback)` (report-ranges.ts) is pure, clock-injectable,
  idempotent — one `now` per resolution.
- `resolveWindow` (router.ts) stays the single resolver; precedence doc rewritten ("preset
  wins"; CUSTOM half-open; one `new Date()` per call).
- `9999` gone from the query boundary; `0001-01-01T00:00:00` kept and documented as
  "beginning of records" per the contract docstring.
- Contract docstrings updated in both schemas (core.ts).
- Tests deterministic: clock-injected `now`; router tests use synthetic 2020/2099 rows.

**Judgement calls → resolved:**
1. **Duplicated Code** — three branches repeated `resolveBoundsWindow(...)` + `from > to →
   INVALID_RANGE`. → extracted one `windowOrThrow` closure (router.ts); the three branches
   now differ only by their input selection.
2. **Speculative Generality (dead fallback)** — `resolveBoundsWindow`'s both-absent fallback
   is RPC-unreachable. Kept: it keeps the helper total and is unit-tested; noted in evidence.
3. **Weakened empty-string guard** (old `validCustomRange` rejected `""`) — now schema-only.
   `localDateTimeSchema` already blocks empty strings app-wide; low risk.
4. `resolveReportRange`'s CUSTOM case stays for the pure module's totality (unit-tested
   pass-through); the router intercepts CUSTOM before it.

## Spec

Issue #54: absent upper bound clamps to `now()` (Algeria-local) consistently in report-window
resolution and the expense-list query path; no 9999 in the query boundary; regression: a
future-dated expense must NOT appear in a from-only expensesList/profit-report query; to-only,
from+to, preset windows unchanged; pure/additive router changes.

**Implemented, verified:**
- Clamp uses the same clock as the report windows (`localDateTime`, Africa/Algiers, second-
  inclusive — matches "Both bounds are inclusive").
- Both consumers route through `resolveWindow` → `resolveBoundsWindow` with one shared instant
  (reportsProfit preset path and expensesList).
- No year-9999 sentinel remains in the boundary (grep clean; remaining `9999` in tests are
  passwords/port numbers).
- Router changes additive: same signature, same call sites; bare `preset:"CUSTOM"` + bounds
  rejection preserved and now pinned.

**Deliberate scope notes (documented in the design doc):**
- **Single-bound CUSTOM pair now resolves instead of `INVALID_RANGE`** — both directions.
  Required for the wire-expressible "from-only profit report" (`reportsProfit` has no bare
  from/to; only `preset:"CUSTOM"` + `customFrom`), and made symmetric (customTo-only opens at
  the beginning of records). No existing test pinned the old rejection; acceptance pins only
  bare to-only/from+to/presets as "unchanged", which hold.
- **Future `from` (> now) now rejects `INVALID_RANGE`** instead of silently returning the
  9999 window — tightening consistent with the existing "ordered bounds" policy.

## Verdict

Standards: 0 hard violations after the dedupe round; 2 judgement calls (dead fallback, schema-
only guard) documented as residual. Spec: no missing or wrong requirements; 2 small deliberate
extensions (symmetric CUSTOM pair, future-from rejection) recorded in the design doc and this
report.