# Code review — issue #181

Base: `8bf2a81` · Reviewed head: `b9a6166` · Tier: **High-assurance**
Method: `code-review` skill — Standards and Spec axes in parallel sub-agents over
`git diff 8bf2a81...333e870`, then the Standards findings were applied and
committed as `b9a6166` and the affected suites re-run green.

## Standards

No hard violations. One documentation drift note and six Fowler-baseline
judgement calls (from the reviewer):

1. **Duplicated Code — unique-violation refusal mapping** at two catch sites.
   → **Fixed**: one `duplicateKeyRefusal(error: Error)` helper used by both.
2. **Duplicated Code — "is an explicit key present"** written twice (once
   inverted). → **Fixed**: one shared `hasExplicitIdempotencyKey` predicate used
   by `adjustmentDedupKey` and `hasSupplierAdjustment`.
3. **Data Clumps** — `AdjustmentDedupInput` restates `SupplierAdjustmentSignature`.
   → **Dismissed**: the pure `lib/` module must not import the store's port type
   (layer direction); the structural duplicate is the seam that keeps the key
   function unit-testable without the store.
4. **Primitive Obsession** — `dedup_key` is a prefixed string. → **Dismissed**:
   the namespace is confined to one function and pinned by a golden-string test.
5. **Loose spread** — backfill passes `{ ...row, serverStamped: false }` with an
   extra `id`. → **Dismissed**: structural typing, no behavioural effect.
6. **`isUniqueViolation` text sniffing** also swallows a PK collision. →
   **Dismissed**: `id()` is `randomUUID`; narrowing risks under-matching a driver
   reword.
7. **Doc drift (not in the diff):** `engineering-workflow.md` calls `.scratch/issues/`
   "ignored" while the repo tracks them. Pre-existing; out of scope.

ADR-0011 conformance, ADR-0008 §4.5 version refusal, ADR-0009/0010 invariants,
one-canonical-key locality (codebase-design), and implementation-free `CONTEXT.md`
(domain-modeling) are all satisfied.

## Spec

No missing or partial requirements; all five issue requirements are present and
verified by tests. No blockers. Notes from the reviewer:

- **Gap 1** fixed (optional `idempotencyKey`, forwarded, changed-timestamp retry
  refused); **Gap 2** fixed (partial unique index, schema bump, atomic backfill,
  violation → `DUPLICATE`); money invariants intact; the blocking migration test
  is complete; the bulk-vs-manual overlap is preserved; the design doc states the
  key/signature composition.
- **Scope creep (benign):** keying the raw `insertSupplierEntry` seam is beyond the
  issue text but is listed in the design's interfaces/planned tests and serves "the
  DB stays the authority". Hoisting `setupSupplier` is test-only.
- **Stale-line check:** the reviewer flagged the design's old "a same-signature
  different-key insert is allowed" line. That line was already corrected at the
  reviewed SHA (`181-design.md`: "a same-signature different-key insert is still
  `DUPLICATE`"); no action.
- **Residual (documented):** the v4 backfill keys a legacy server-stamped row with
  the time-inclusive signature, while a post-migration keyless server-stamped
  retry computes the timestamp-free key; those never collide, so the index does
  not backstop a concurrent stamped retry against a *pre-existing* row (the
  in-store signature guard still does). Pre-existing gap, not widened; the choice
  is deliberate (see the debate synthesis).

## Summary

- Standards: 7 findings — 2 fixed, 5 dismissed (plus 1 pre-existing doc note).
- Spec: 0 missing, 0 wrong, 2 benign scope notes, 1 residual documented.
- Worst issue within each axis: Standards — the duplicated key-predicate/refusal
  mapping (fixed); Spec — none.

## Post-fix verification

- `bun test` on the three supplier suites → 64 pass, 0 fail.
- `bun run lint` → 0 errors; `bun run typecheck` → 0 errors.
