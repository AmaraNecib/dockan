# #183 — test-audit evidence

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `da44b502d39c79a1368e9848542d9a25fac301fc`
- **Head:** `3f814b13fdb96fd0578b3151804b6b55ad095e1f`
- **Audit rounds:** `f590c32` (round 1), `45ae313` (round 2), `2594889` (round 3)
- **Verdict:** acceptance fully mapped; every reported gap fixed or dismissed.

## Acceptance → test map (final)

| Acceptance bullet | Test |
|---|---|
| Conflict check uses the names-only lookup | `supplier-opening-balance.test.tsx` — `never loads the full party list — the conflict check rides the names-only seam (#183)` (asserts `suppliersListUsed === false`) and `folds a typed name onto an existing supplier from the names-only list (#183)` |
| No unconditional full-party load on that page | same `never loads the full party list…` test; the mock's `suppliersList.queryOptions` flips a flag if touched |
| A name folding onto an existing supplier is detected | `folds a typed name onto an existing supplier from the names-only list (#183)` (double-space fold onto `s-3`, confirm dialog, `confirmExisting: true`) |
| Two outgoing rows folding to one name are detected | `blocks two outgoing rows folding to one name before the server (round 5)` + `blocks a typed name whose supplier already has a filled row instead of double-posting (round 5)` |
| No change to the server resolution contract | `sends a typed name as newSupplierName, never a pre-resolved id (round 5)`; router diff is two read-only handlers |
| No schema change | structural — no migration/schema file in the diff |

## Edge-case hunter findings and disposition

| # | Risk | Finding | Disposition |
|---|------|---------|-------------|
| 1 | HIGH | A supplier with entries but net-zero balance must still be counted (the gate keys on count, not balance). | **Fixed**: store test asserts `{ accountBalance: 0, accountEntryCount: 2 }`. |
| 2 | MED | Only one of the two reads failing was untested; a swallowed summary error would silently enable the save. | **Fixed**: page test `blocks the save when the account summary fails…`. |
| 3 | LOW | Empty summary / empty names list unasserted. | **Dismissed**: `COUNT(*)` never yields a zero-count row; the page defaults a missing id to 0/0 and the 200/201-row tests exercise the empty-summary path. |
| 4 | LOW | Merge ordering determinism unasserted. | **Fixed**: store test compares `listPartyNames` order to `listParties` order. |
| 5 | LOW | The two-read `settle()` needed a third tick. | **Accepted**: pre-existing harness pattern; the OR'd `listPending` is correct. |

## Coverage analyst findings and disposition

- Round 1: acceptance bullet 2 ("no full-party load") had no direct test. **Fixed** — the `never loads the full party list` test.
- Round 2: the success path's invalidation was unasserted; the names-only error branch was untested. **Fixed** — `refreshes suppliers after a confirmed refusal too` now asserts `["suppliersList"]`, and the summary-error test covers the OR.
- Round 2/3: the dialog-open-then-read-fails test exercises the `disabled` gate, not the defensive `save()` guard. **Accepted** — the guard is defence in depth; the user-facing contract is the disabled button.
- Missing-summary default `0/0` is implied by the 200/201-row fixtures; the store test pins the underlying omission.

## Quality reviewer

Grade B+ (round 2). Names are behaviour-focused and cite the issue; assertions
pin wire shape (`Object.keys(...).toEqual(["id","name"])`) and sign agreement with
`listParties`; the mock mirrors the server's omission of entry-less suppliers.
Deductions: fixed-tick `settle()`, the 200-row tests run close to the 60s budget,
and the dialog-gate test clicks a disabled button.

## Tests executed at the final SHA

- `apps/web`: `bun test --max-concurrency=2` → **852 pass / 0 fail**.
- `apps/api`: `bun test --max-concurrency=2` → **860 pass / 0 fail**.
- `apps/web/src/pages/supplier-opening-balance.test.tsx` → **24 pass / 0 fail**.

## Full Playwright (Guard 2)

Two full `bun run test:e2e` runs each failed a *different* set of unrelated specs
(run 1: `00-onboarding`, `activity`, `debts`, `expense-reports`,
`items-categories`, `stock-ledger`; run 3: `debts`, `expense-reports`,
`learnability`, `stock-ledger`, `vault`). `supplier-adjustment.spec.ts` (the
#183 flow) passed both times.

Per `.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md`, an
isolated-pass / full-fail split is a stale-server/DB-pollution symptom. Verified:

- All 8 failing spec files were re-run in isolation with a fresh wipe; 7 passed
  (`00-onboarding` 5, `activity` 1, `debts` 1, `expense-reports` 4,
  `items-categories` 1, `stock-ledger` 2, `learnability` 7).
- `vault.spec.ts:166` failed in isolation, and **fails identically on base
  `da44b50`** without this change (`/tmp/iso-vault-base.log`). Pre-existing,
  unrelated to #183.

No e2e failure is attributable to this change.
