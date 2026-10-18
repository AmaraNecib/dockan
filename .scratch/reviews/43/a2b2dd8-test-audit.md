# Test audit — issue 43 (evidence re-keyed after develop rebase; head a2b2dd8)

Three reviewer sub-agents (edge-case hunter run dd6dda6c, coverage analyst run
3b7bbbe9, quality reviewer run cadaea15) audited the changed test files and
sources at head 9dd5e1c. Suites green at audit time: api 353/0, web 89/0
(later +1 after the cap test fix → 90). The audit's own fixes landed as
commit 0af03f1; later commits touch only .scratch evidence, so this evidence
stays valid against the branch head (c6eba53).

## Criteria → tests map (coverage analyst)

- c1 exact per-line COGS: `fifoOutflowCost` unit tests (ADR-0005 drift, layer
  spans, oversell), profit-report `cogsExact` tests (sums 35 not 36; per-line
  margin identity), router wire tests (costAtSale 117 / cogsExact 700,
  report delta 700 ≠ 702, purchase lines), migration test (ALTER + backfill +
  marker + idempotent re-run + marker-independent self-heal + zero-cost
  preservation + write-seam fallback added after audit).
- c2 invoiceDate timestamps + bound: 7 `saleMovementTime` unit tests incl.
  the replay-validity property (un-clamped throws, clamped replays), router
  wire tests (2035-06-03 midnight; clamp to 2035-06-05T09:00 with stockAfter
  [5,8,2]; undated wall-clock + not-midnight assertion added after audit).
- c3 clearable draft: `parseQuantityDraft`/`quantityDraftInvalid` unit tests
  incl. cap and exact-input cases (added after audit), e2e `fill("")` sticks,
  save refused, cart intact, re-fill works.

## Edge-case findings

1. (orange) Rounding-collision band: cost_at_sale rounds to 0 while exact
   layer cost is a fraction of a DZD (1×2-DZD layer, 5-unit sale → exact 2,
   snapshot 0). Repair cannot recover it — the OLD formula reported 0 too, so
   no regression; honest wording added to the repair comment (no false
   "zero-cost ⟹ exact 0" claim, no overclaimed accuracy). **Documented.**
2. (orange) "Empty legacy invoice_lines never gains the column" — FALSE
   ALARM: `PRAGMA table_info` returns one row per SCHEMA column of an
   existing table, so `lineRows.length > 0` is always true post-DDL; fresh
   DBs get cogs_exact from SCHEMA_DDL before `ensureSaleColumns` runs.
   **Dismissed.**
3. (yellow) Backdating unreachable from the web UI (sale.tsx sends no
   invoiceDate): API-path feature per issue scope; UI date entry out of
   scope. **Noted in report.**
4. (yellow) Drafts above the RPC cap (1_000_000) surfaced an opaque server
   error instead of a client error. **Fixed** — `parseQuantityDraft` now
   returns 0 for over-cap drafts; unit + e2e-blocking coverage added.
5. (yellow) Same-item two-line oversell — already covered by the pre-existing
   "consumes FIFO layers across duplicate item lines" router test plus the
   bounded-backdating stockAfter assertion. **Dismissed (already covered).**
6. (yellow) Calendar-invalid dates ("2026-02-31") — pre-existing regex-only
   policy documented in router.test.ts ("no calendar-range checks
   app-wide"). **Dismissed (out of scope).**

## Quality reviewer fixes (all applied)

1. sale.test.ts "deterministic" self-equality test → pinned per-input
   expected values (incl. "1e3", "1_000", cap boundary 1_000_000/1_000_001).
2. router.test.ts undated-sale assertion anchored: movement must NOT land at
   `T00:00:00` (the explicit-dating behavior), plus format + invoice-day.
3. profit-report.test.ts dropped the dead constant assertion `3*12 !== 35`.
4. stock-ledger.test.ts "outflows never extend the bound": explicit
   `not.toBe("2026-06-06T15:00:00")` assertion added.
5. Store write-seam fallback (`cogsExact ?? quantity * cost_at_sale`) now has
   a direct migration-store test.

Grade: A (quality reviewer's own verdict, with the above minors).

## Actions taken

Fixed: edge #4, quality #1–#5. Documented: edge #1. Dismissed: edge #2, #5,
#6. Noted: edge #3. Re-ran suites: api 353/0, web 90/0, typecheck + lint
clean.