# Debate — issue #176 supplier adjustments (High-assurance)

Reviewed SHA: `ef0e885` (base `1840a3a`). Two adversarial rounds (critic vs
defender) were run, plus a final critic pass at `ef0e885`. Test quality and the
two-axis code review are separate evidence files.

## Round 1 (critic vs defender) — at `01c11d3`

The critic raised 18 findings. The money-critical ones:

- **[8] `listParties` clamped the signed account balance to ≥ 0.** `safeWhole`
  was applied to `accountBalance`, so a credit («يسالنا») showed as `0` on the
  supplier list while the detail and /debts showed the negative balance.
- **[7] SQL vs pure sign divergence on a null-direction ADJUSTMENT.** The SQL
  CASE signs it negative; `supplierEntrySign` throws. Reachable only by a write
  that bypasses the store.
- **[6] The bulk screen's inline new name could duplicate an existing supplier**,
  splitting one account across two.
- **[6] Stale-expectation confirmation dead-end** (client-derived confirmation).
- **[5] `returnCreditAmount` summed linked adjustments without a direction
  filter.**
- Plus minor items: dead i18n key, duplicate testid, key collision, zero-preview
  label, stale invoice selection.

The defender argued the four headline decisions (one derived-remaining
mechanism, refusal-not-credit for links, additive migration, one SQL sign
helper) are correct and appropriately conservative (9/10).

## Round 1 fixes — commit `f5bf625`

- `safeSignedWhole` for `accountBalance` (signed, clamps only to
  ±`MAX_SAFE_INTEGER`); store test asserts `-300` on both the list and /debts.
- `assertAdjustmentDirection` at the store seam + fresh-DDL
  `CHECK (kind <> 'ADJUSTMENT' OR direction IS NOT NULL)`.
- `returnCreditAmount` filters `direction = 'THEY_OWE'`.
- Bulk screen: duplicate-name guard (`normalizeTextKey`), signed current-balance
  rendering, key by `supplierId`, server-refusal confirmation.
- Panel: re-derived invoice selection, zero-preview direction drop.
- Tests: exact-boundary full write-off, THEY_OWE parity, null-direction refusal,
  mixed-batch rollback, backdated date, signed list balance, duplicate-name guard.

## Round 2 (critic vs defender) — at `f5bf625`

The critic found one genuine **blocker**: the new stale-expectation confirmation
was inert — `setConfirming(true)` in the `catch` was immediately overwritten by
`finally { setConfirming(false) }`. The defender confirmed all four headline
decisions and the round-1 fixes are sound; it noted the client-only
duplicate-name guard is the correct level (ADR-0007 forbids a server name
refusal).

## Round 2 fix — commit `ef0e885`

- `setConfirming(false)` moved to the success path only; `finally` sets only
  `setSubmitting(false)`. The dialog now survives the server's
  `OPENING_BALANCE_EXISTS`. A component test drives the stale-expectation path.
- Duplicate testid removed; unused `supplierOpeningAmountRequired` key removed;
  store test asserts both directions and THEY_OWE SQL/pure parity; router tests
  for a wrong-supplier link, a sale-invoice link, empty rows and a zero amount.

## Final critic pass — at `ef0e885`

**No blocker.** The round-2 blocker is verified fixed; no regression in the
money/ledger/migration code (re-ran the ledger, store, migration, and router
suites: 218 pass / 0 fail). Residual low-severity notes:

1. SQL vs pure sign divergence for a raw/hand-edited null-direction ADJUSTMENT
   (the ALTER path cannot carry the CHECK) — deferred hardening (`#176-followup`).
2. A hand-crafted bulk batch with the same `supplierId` twice is not deduped —
   the UI cannot produce it.
3. New parties are created in the plan phase; safe because the whole batch is
   one `BEGIN IMMEDIATE` unit (rollback tested).

## Deferred (non-blocking, follow-up issue proposed)

- Server-side duplicate-name refusal in the bulk endpoint (currently client-side
  only, because ADR-0007 permits duplicate names).
- A store-seam assertion that any `invoice_id`-bearing ADJUSTMENT is `THEY_OWE`
  (today enforced by contract + router + conditional UPDATE).
- Partial-payment linked-discount test (the invariant is proven on a fully
  unpaid invoice; the arithmetic is the same term).
