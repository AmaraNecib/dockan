# #183 — test-audit evidence

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`, post-rebase)
- **Head:** `29828a659032d45e613ffc8234476d4e5b0c06f6`
- **Audit rounds:** `e9d5d85` (round 1), `c93cfd7` (round 2), `b0892c7` (round 3)
- **Verdict:** acceptance fully mapped; every reported gap fixed or dismissed.

## Rebase addendum (landing round)

Rebased `da44b50` → `f757211`. No conflicts, no behavioural change: the branch
patch is textually identical before and after (see the code-review addendum),
and develop's own test changes in the shared files survive — `clientForStore`
(#181) and the `DEFAULT_PAGE_SIZE` pagination note (ticket-8) are both in
`apps/api/src/rpc/router.test.ts` at HEAD. The audit findings below are
unaffected. Tests were re-executed at the rebased head; the previous round's
e2e flakiness did **not** reproduce (see *Full Playwright* below).

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

## Tests executed at the rebased head (`29828a6`)

Commands and exit codes (ports isolated to `DOKAN_PORT=4473` /
`DOKAN_WEB_PORT=5273` to avoid the sibling lane and `vault.spec.ts`'s hardcoded
4399/5174):

- `bun run typecheck` → **exit 0**
- `bun run lint` → **exit 0**
- `bun run test` → **exit 0** — api 888 pass / 0 fail, web 962 pass / 0 fail,
  desktop 57 pass / 0 fail.
- `apps/web/src/pages/supplier-opening-balance.test.tsx`: pass, 0 fail.

## Full Playwright (Guard 2)

`DOKAN_PORT=4473 DOKAN_WEB_PORT=5273 bun run test:e2e` → **exit 0,
57 passed / 0 failed (5.1m)**.

This supersedes the previous round's note about unrelated spec flakiness: at the
rebased head the full suite — including `supplier-adjustment.spec.ts` (the #183
flow), `pagination.spec.ts` (#174), the quick-add specs (#191) and `vault.spec.ts`
— ran green in a single pass. The earlier failures are attributed to the
stale-server/DB-pollution symptom in
`.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md` and the vault
failure that reproduced on base `da44b50`; neither reproduces now.
