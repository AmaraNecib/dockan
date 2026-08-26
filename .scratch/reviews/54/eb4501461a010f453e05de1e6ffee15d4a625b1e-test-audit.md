# Test audit — from-only expense windows clamp to now (issue #54)

- **Final head reviewed:** eb4501461a010f453e05de1e6ffee15d4a625b1e
- **Base:** 96afde9 · **Gate at this head:** `bun run typecheck` ✓ · `bun run lint` ✓ ·
  `bun run test` 294 pass / 0 fail ✓ · e2e 17/17 ✓ · `.dokan-port` restored byte-exact

Three sub-agents (edge-case hunter, coverage analyst, quality reviewer) audited the new tests
at the pre-fix-round head d10bb98; the round's fixes were committed at the head above and all
gates re-run.

## Acceptance coverage

| Criterion | Level | Evidence |
|---|---|---|
| from-only query excludes future-dated rows | wire + unit | router.test.ts `from-only windows clamp to now`: bare `from` (past kept via `toContain(past.id)`, 2099 row excluded via `not.toContain`); CUSTOM + customFrom-only report (byCategory `total: 111, count: 1`); report sale-lines delta (revenue +300, COGS +100 — the 2099 invoice contributes nothing); unit pin `to === localDateTime(now)` exactly |
| to-only / from+to / presets behave as before | wire | bare to-only open-ended (both rows inside a 2099 `to`); from+to exact single-row window scoped to the test's own category; existing preset tests untouched |
| unit + router tests cover the boundary | unit + wire | 7 unit tests (clock-injected incl. local-midnight rollover, single-instant clamp, idempotency) + 2 wire tests (both run last, shared store verified non-contaminating) |
| e2e unchanged | e2e | no spec touched; full suite 17/17 at the head |

## Findings → resolutions

1. **(edge 🟠) "(unchanged)" labels overclaim** — the custom pair's single-bound behavior
   changed from `INVALID_RANGE` to a half-open window; comments claimed "unchanged".
   → comments rewritten to say so explicitly; the deliberate change is documented in the
   resolver docstring and the design doc's Risks.
2. **(edge 🟠) clamp-instant boundary unpinned** → unit test added: `from` exactly at the now
   instant resolves to a single-instant inclusive window (never empty/rejected).
3. **(edge 🟡) zod guard is shape-only** (calendar-invalid dates pass) → pre-existing,
   app-wide regex-only timestamp policy, documented residual from issue #31; unchanged.
4. **(edge 🟡) `preset:"CUSTOM"` + bare `from`/`to` rejected** → pre-existing precedence
   ("preset wins"; CUSTOM's input is the custom pair) — now pinned by a wire test.
5. **(coverage) from-only + `categoryIds` untested** → wire test now combines both filters
   (store ANDs them).
6. **(coverage) from-only report with sale lines untested** → future-dated SALE invoice
   exclusion proven by revenue/COGS deltas.
7. **(quality) exact-match `toEqual([mid.id])` over all categories in a shared store** →
   scoped with `categoryIds: [op.id]`.
8. **(quality) idempotency unit test near-tautological** → kept: it pins the acceptance item
   and is trivial to hold.

## Residual (documented)

- A future-dated expense inside the CURRENT_MONTH preset's own window still shows: month
  windows have an explicit upper bound (month end) — that is preset semantics, not the
  from-only absent-bound leak this issue closes.
- `resolveBoundsWindow`'s both-absent fallback is RPC-unreachable (expensesList injects
  CURRENT_MONTH; reportsProfit requires a preset) — kept for the pure helper's totality,
  unit-tested, and used as the `fallback` default.

## Verdict

Grade A-: the two previously-red regressions (leak; from-only report rejection) are now
pinned at both resolver and wire layers with id/amount-level assertions, clock-injected
where injectable and 2099/2020 margins where the wire clock is real.