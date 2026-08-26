# Code review — issue 43 (standards + spec, re-keyed after develop rebase; head a2b2dd8)

Two-axis review by parallel reviewer sub-agents (standards run 7431c575, spec
run 2335b054) over `git diff 0de1265...13e9927`; a delta re-review (run
94a484c0) verified the review-fix commit e1e303f on top. Later commits touch
only .scratch evidence.

## Standards (run 7431c575)

Compliance verified in the diff — no hard violations:
- SAFETY: comments retained on every raw-query cast (marker queries,
  `listSaleLinesForProfit` aliases); whole-DZD integers (`cogsExact:
  dinarsSchema`); snake_case `cogs_exact` → camelCase `cogsExact` consistent
  through `lineCols`, `toInvoiceLine`, SELECT alias; append-only ledger;
  pure math modules (`fifoOutflowCost`, `saleMovementTime` in
  stock-ledger.ts); migration + backdate rules documented in code and
  ADR-0005.
- Documented deviation: `migration.cogsExactV1` marker is written but the
  repair UPDATE is deliberately not marker-gated (greptile-P1 symmetric-trap
  rationale inline, idempotent via WHERE invariants, tested). Judgement call,
  standards-compliant.

Baseline smells (judgement calls) and disposition:
- Middle Man / Speculative Generality: `fifoCostForOutflow` became a 1-line
  wrapper over `fifoOutflowCost` with no production callers after the router
  switch. **Fixed in e1e303f** — wrapper removed, tests merged into the
  `fifoOutflowCost` suite (ADR-0005 drift example retained), ADR reference
  updated; delta re-review confirms no callers remain (only .scratch text).
- Stale SAFETY comment in profit-report.ts described the removed
  quantity × costAtSale formula. **Fixed in e1e303f** — comment now matches
  the `cogsExact` summation.
- Duplicated `ProfitSaleLine` shape across port.ts / profit-report.ts:
  pre-existing structural seam (store vs pure-module boundary), extended
  consistently; not new.
- Divergent Change (`cogsExact` across schema/contracts/store/router/report):
  inherent to an additive column through the mandated layered stack.

Residual risks: backfilled SALE rows keep approximation accuracy (honest);
backdated sales clamp to newest inflow (documented); per-boot repair UPDATE is
a full-table scan.

## Spec (run 2335b054)

- (a) Missing/partial requirements: **none**. Item 1's mandated
  derivability check was performed (rounded `cost_at_sale` is lossy — gap
  real, per ADR-0005 2×10+1×15 example) so the minimal additive column is
  justified; item 2's bound `max(invoiceDate T00:00:00, newest inflow)` is
  implemented, outflow-immune, and replay-validity-tested; item 3's string
  draft + deterministic parse + e2e is in place.
- (b) Scope creep: **none material**. Self-heal UPDATE deviates from the
  design's marker-gated backfill (deliberate debate fix, invariant-gated,
  documented); client-side `MAX_LINE_QUANTITY` cap mirrors the RPC contract;
  BEGIN IMMEDIATE units left untouched except the note.
- (c) Implemented but wrong: **none**. `fifoOutflowCost` validation parity,
  router `totalCost`/`quantity × unitCost` writes, report `cogsExact` sum,
  repair invariant (`costAtSale > 0 ⇒ exact > 0` for modern rows), `??`
  write-seam fallback preserving explicit 0, undated wall-clock flow.

Notes: string-compare ordering is safe while all writers emit
`YYYY-MM-DDTHH:mm:ss` (pinned by tests); clamped day slices are a documented
consequence; pre-#43 SALE rows keep the old-formula (approximate) COGS.

## Delta re-review (run 94a484c0, commit e1e303f)

PASS on all four checks: no production `fifoCostForOutflow` callers; merged
tests keep discrimination + drift example; SAFETY comment matches arithmetic;
typecheck/lint/targeted tests green (stock-ledger 30/0, profit-report 17/0;
full suites + e2e 17/0 re-run green on the final head).

## Summary

Standards: 3 findings, worst = Middle Man wrapper (fixed). Spec: 0 findings.
No remaining actionables.