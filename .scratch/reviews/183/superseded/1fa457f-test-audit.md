# #183 — test-audit evidence (review-fix round 1)

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- **Head:** `1fa457f2e15e4b9a04f932defc3c64083cb2528d`
- **Round:** review-fix 1 — Greptile 4/5, one finding (test gap)
- **Audited file:** `apps/web/src/pages/supplier-opening-balance.test.tsx`
  (`git diff f757211...HEAD --name-only -- '*.test.ts'`)
- **Verdict:** the gap is closed and mutation-verified; the class check found no
  other same-shape test; one further coverage gap was fixed, the rest deferred.

## Greptile finding and fix

Greptile: the confirmed-refusal test asserted `suppliersListNames` and
`suppliersList` but **not** `suppliersAccountSummaries`, and the two recovery
tests refreshed both lean keys **themselves**. A change leaving the owner
retrying with **stale entry counts** — the numbers the confirmation gate reads —
would have passed.

Fix in `1fa457f`:

1. `refreshes suppliers after a confirmed refusal too (Greptile round 3)` now
   asserts all three keys, incl. `suppliersAccountSummaries`.
2. Both recovery tests (`surfaces the confirmation dialog when the server refuses
   a stale-expectation row`, `names and confirms a raced named row only after the
   refusal refreshes it`) now mutate the mock backing data **before** the refusal
   click and **never** call `invalidateQueries`. The only refetch source is the
   page's own catch handler.
3. The success-path spy test (`invalidates the real debts and dashboard keys
   after saving`) asserts the same three supplier keys.

### Mutation proof (required by the brief)

Temporarily removed `orpc.suppliersAccountSummaries.queryKey()` from
`supplierReadQueryKeys` in `supplier-opening-balance.tsx`, ran the file, restored
the page (`git checkout --`). Result: **4 fail**, exactly the tests that assert
the account refresh, each on its discriminating assertion.

```
(fail) surfaces the confirmation dialog when the server refuses a stale-expectation row (round 5)
       → dialog textContent lacked the refreshed supplier name
(fail) invalidates the real debts and dashboard keys after saving (Greptile finding 5)
       → keys lacked ["suppliersAccountSummaries"]
(fail) names and confirms a raced named row only after the refusal refreshes it (round 5)
       → captured undefined: the typed row stayed unconfirmed and the mock refused again
(fail) refreshes suppliers after a confirmed refusal too (Greptile round 3)
       → keys lacked ["suppliersAccountSummaries"]
```

Log: `.scratch/reviews/183/logs/mutation-final.log` (gitignored). The page was
restored and the clean tree re-verified (`grep -c` → 1).

## The class, not just the site

The failure mode is "a test supplies what the page is supposed to supply".
Every test that touches the three supplier keys was classified:

| Test | Shape | Detects a missing account refresh? |
|---|---|---|
| `surfaces the confirmation dialog … stale-expectation (round 5)` | supplies the page's refresh | **Yes** — dialog-names assertion + `confirmExisting` payload |
| `names and confirms a raced named row … (round 5)` | supplies the page's refresh | **Yes** — `confirmExisting: true` payload for the raced row |
| `refreshes suppliers after a confirmed refusal too (round 3)` | spies on `invalidateQueries` | **Yes** — new key assertion |
| `invalidates the real debts and dashboard keys after saving` | spies on `invalidateQueries` | **Yes** — new key assertions |
| `blocks the confirm-save when the account summary fails after the dialog opens` | self-invalidates to inject a failure | n/a — legitimate setup, no recovery to supply |

**No other same-shape test exists** in `apps/web/src`
(`supplier-adjust-panel.test.tsx`, `router.test.tsx` only spy/stub). Independent
coverage/mutation reviewer confirmed both converted tests are genuinely
mutation-sensitive and that red/orange findings on the refresh class were **none**.

## Edge-case hunter findings and disposition

| # | Risk | Finding | Disposition |
|---|------|---------|-------------|
| 1 | 🟠 | Only the account read's failure was tested; the names-only read failure (`listError` prefers it, tsx:89) was unexercised. | **Fixed**: added `namesShouldFail` to the mock and `blocks the save when the names read fails instead of skipping the conflict check (#183)`. Both read-failure tests now prove the guard with `requestSubmit()` (bypasses the disabled button). |
| 2 | 🔴 | A refresh that drops/renames a supplier leaves its `drafts[id]` unread → the amount is silently dropped, no block. | **Deferred — product decision.** Pre-existing (same drafts-by-id shape before #183); a dropped supplier means the row also leaves the table, and the server refuses a write to a deleted supplier. Not silently fixed; see the crew report decision request. |
| 3 | 🟠 | A summary row whose id is absent from the names list is ignored by the merge (tsx:83-86). | **Dismissed**: the summary is derived from the same supplier set as the names list, so an id cannot appear in one and not the other in production; the merge default `0/0` is intentional. |
| 4 | 🟠 | No page fixture has `accountEntryCount > 0` with `accountBalance === 0`; the gate must key on count, not balance. | **Deferred**: the store test already pins `{ accountBalance: 0, accountEntryCount: 2 }` (`drizzle-store.test.ts`); adding it to `BASE_SUPPLIERS` would shift every existing row index. Low marginal value. |
| 5 | 🟡 | Empty names/summary list unasserted. | **Deferred** (follow-up). |
| 6 | 🟠 | Stale count dropping to 0 on the confirmed path unasserted. | **Deferred** (follow-up). |
| 7 | 🟡 | `opening-balance-loading` never asserted; `submit()` doesn't guard `listPending`. | **Deferred** (follow-up). |
| 8 | 🟡 | Draft preservation / converse-collision after the refusal refresh unasserted. | **Deferred** (follow-up). |

## Quality reviewer

**Grade B.** The two recovered tests have real teeth (verified independently):
after the diff, the page's catch handler (tsx:158-163) is the only refetch source,
and the payload assertions require `forwardsConfirm(true, ≥1)` from refreshed
counts. Deductions, with dispositions:

- `clickOn(save); expect(captured).toBeNull()` after a `disabled` assertion is a
  no-op (7 pre-existing sites). **Fixed for the two read-failure tests** via
  `requestSubmit()`; the remaining autoregressive clicks are pre-existing and
  deferred.
- The invalidation spy asserts the mock's own `queryKey()` returns — it proves
  invalidation *was attempted* for the right key, which is the contract the test
  can reach through the module boundary. Judged acceptable.
- `settle()` is three `setTimeout(0)` ticks; duplication and bulk-test cost
  (75 s of 85 s) are pre-existing harness facts, not this round's regression.

## Tests executed after the fix

- `bun test src/pages/supplier-opening-balance.test.tsx` (from `apps/web`) →
  **exit 0**, **25 pass / 0 fail**.
- `bun run test` → **exit 0** — api 888/0, web 963/0, desktop 57/0.

Full Guard 1 / Guard 2 commands and exit codes are in
`.scratch/reviews/183/1fa457f-guard.md`.
