# Debate — issue 43 (evidence re-keyed to final code head 13e9927)

Reviewers: critic (reviewer sub-agent, run b2752984) + defender (reviewer
sub-agent, run 2a9d6db4) over `git diff 0de1265...HEAD` at head f06ce89.
Both agents verified the FIFO replay-validity claim and tie-break ordering
before reporting; unit/web/store suites (47/21/52) green at review time.
The debate's own fixes landed as commit 9dd5e1c (see "Actions taken"); the
file is re-keyed to the code head 13e9927 — later commits touch only
.scratch evidence, so this evidence stays valid against the branch head.
at 9dd5e1c cover that delta independently.

## Critic findings (severity 1-10)

1. **6 — migration marker staleness (drizzle-store.ts migration, cogs_exact):**
   If the marker lands and the binary later rolls back to a pre-#43 build
   (whose `INSERT invoice_lines` writes DEFAULT 0 into the now-existing
   column), a re-upgrade skips the backfill because the marker exists; those
   rows then report 0 COGS, silently inflating profit — the symmetric trap of
   the greptile-P1 comment that column presence must never gate backfills.
   **Action: FIXED** — the repair UPDATE is now run on every boot, guarded only
   by the row invariants (`cogs_exact = 0 AND quantity > 0 AND cost_at_sale >
   0`), marker-gating only the diagnostic marker write; a migration test pins
   the heal (and that zero-cost rows are never rewritten).
2. **5 — backfill stamps approximation on all #30-era SALE rows:** the
   upgrade path includes databases containing REAL SALE rows (not a "stub"
   era); those get `quantity × cost_at_sale`, i.e. the OLD report formula —
   no numeric regression, but not exact for pre-#43 history.
   **Action: DOCUMENTED (accepted tradeoff)** — ADR-0005 + migration comment
   now state exactly which rows are exact vs. old-formula.
3. **5 — clamp vs invoice date:** a backdated invoice predating the newest
   inflow places the movement at the inflow timestamp, so day-level
   stockAsOf/history slices between the two dates show the stock still
   present; the issue's "movement follows invoiceDate" holds only where
   replay-validity permits. **Action: DOCUMENTED (designed bound)** — the
   issue itself mandates "never before the last purchase movement";
   `saleMovementTime` doc + ADR now state the accepted consequence.
4. **4 — dead COALESCE + no reconciliation:** `COALESCE(l.cogs_exact,
   quantity*cost_at_sale)` in listSaleLinesForProfit is dead code with a
   NOT NULL column and cannot guard the marker-staleness trap.
   **Action: FIXED** — COALESCE removed; the invariant-restricted repair owns
   row honesty instead.
5. **3 — cogsExact required in invoiceLineSchema:** out-of-repo consumers of
   the inferred type break. **Action: DISMISSED** — in-repo contract, and the
   sibling additive fields (netTotal, discountAllocated) are likewise required
   in the output schema; the insert seam keeps them optional.
6. **3 — parseQuantityDraft coerces overflow/leading zeros; no inline invalid
   styling:** overflow → 0 (blocked at submit), "007" → 7 (harmless), no
   per-line red border until submit. **Action: DISMISSED (per design)** — the
   submit-time error covers it; inline styling out of scope.
7. **2 — addLine repairs a cleared draft to "1", contradicting the "draft is
   never rewritten" doc comment.** **Action: FIXED (doc)** — comment now says
   the input never rewrites the draft; only an explicit add-line action
   repairs an invalid draft.

## Residual risks (no change)

- Multi-line same-item duplicate invoice: per-line validation, not cumulative
  — pre-existing, unrelated to #43.
- Same-instant tie order depends on rowid monotonicity within the store's
  connection — asserted implicitly by store ordering tests, not explicitly by
  #43 tests.

## Defender highlights (confidence)

- Design doc did the issue's mandated "can the reports derive it?" check first
  (lossy rounding at stock-ledger.ts; order-unstable replay) → 9/10.
- Explicit-invoiceDate-only backdating keeps undated flows byte-identical;
  clamp generalizes "last purchase" to any inflow (MANUAL_ADJUSTMENT layers)
  → 9/10.
- `fifoCostForOutflow` delegation preserves the public API and all callers
  → 10/10.
- String-draft quantity pins the root cause (Number("") === 0 → guard snap)
  and blocks submit without corrupting the cart → 9/10.

## Actions taken

Fixed: #1 (commit 9dd5e1c), #4, #7. Documented: #2, #3. Dismissed: #5, #6.
Deferred (out of scope, listed per issue): BEGIN IMMEDIATE conversion for
itemsCreate, itemsCreateWithStock, itemsUpdate, stockAddManual,
invoicesCreate (SALE + PURCHASE), purchase-intake link/correction units,
expenseCategoriesCreate.