# #183 — code-review evidence (two axes)

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`, post-rebase)
- **Head:** `29828a659032d45e613ffc8234476d4e5b0c06f6`
- **Commits:** `e9d5d85` (implement), `c93cfd7` (failed-read gate + invalidation),
  `b0892c7` (dialog gate + contract `.pick` + tighten), `1db6fb6` (invalidation
  list), `eb686d7` (read-key array resolved at render)
- **Verdict:** Spec — pass. Standards — pass with two judged notes.

## Rebase addendum (landing round)

The branch was rebased from base `da44b50` onto `origin/develop` @ `f757211`.
The rebase applied **cleanly — zero conflicts**, because every #183 hunk lands in
a region the six intervening develop commits (#130, #143, #191, #146, #123,
ticket-8) did not touch. "Clean" is not accepted as proof on its own, so both
sides were verified independently:

- `git diff da44b50 b51b0a7` (pre-rebase branch patch) vs
  `git diff origin/develop HEAD` (post-rebase patch) are **byte-identical apart
  from @@ hunk line numbers and `index` blob hashes** — the transplant changed no
  content, so the reviewed semantics are exactly the ones below.
- develop's own work in the two shared files is intact in HEAD:
  `apps/api/src/rpc/router.ts` keeps `postStockBatch`/`postStock` and the
  `recordStockMovements` import from #143;
  `apps/api/src/rpc/router.test.ts` keeps `clientForStore` (#181) and the
  `DEFAULT_PAGE_SIZE` note from the ticket-8 fix.
- `apps/web/src/pages/supplier-opening-balance.tsx` was **not** touched by
  develop at all (`git diff da44b50 origin/develop -- <file>` is empty), so there
  was no conflict surface there despite #174's pagination work elsewhere.

**No behavioural change resulted, so no new review round was run** (delta-review
criterion in the brief). The base/head lines are re-keyed; the verdicts carry.

## Spec axis

Requirements the issue asked for:

- *"The opening-balance conflict check uses the names-only lookup."* Met:
  `supplier-opening-balance.tsx` reads `orpc.suppliersListNames`
  (`store.listPartyNames`, `{id,name}`); `newOpeningRowStatus({existingNames})`,
  `matchByNormalizedName` and the folded-name `typedNameConflict` all consume the
  merged rows.
- *"No unconditional full-party load on that page."* Met: no
  `orpc.suppliersList.queryOptions()` on the page; a test asserts the seam is
  never touched.
- *"Tests cover a name folding onto an existing supplier; two outgoing rows
  folding to one name."* Met (see the test-audit evidence).
- *"No change to the server's resolution contract."* Met: two read-only `guarded`
  handlers added; `suppliersOpeningBalances` and the #177/#180 resolution logic
  untouched.
- *"No schema change."* Met: contract additions are Zod schemas only.

Scope beyond the literal proposal: a second lean read
(`suppliersAccountSummaries`) is required because removing `listParties` drops
the balance/entry columns the table and the confirmation gate render. It is
documented in `.scratch/implementation/183-design.md` and mirrors the existing
supplier-only `accountBalance`/`accountEntryCount` contract fields. No other
scope creep.

## Standards axis

Documented repo standards — no violations:

- Layering matches `docs/engineering-workflow.md`: contract schemas → store port
  → drizzle impl → `guarded` router handlers → page.
- `sql.raw` sites carry `// SAFETY:` justifications and use the closed
  `PARTY_TABLES` map, matching the `listParties` precedent.
- Sign drift is closed by reusing `supplierSignedAmountSql` and by a store test
  that pins the summary against `listParties` (the
  `2026-10-13-supplier-account-signed-ledger` pattern).
- No new refusal codes, so no i18n debt; refresh-on-refusal follows
  `2026-10-13-refresh-derived-views-on-partial-failure`.
- Port types are re-exported from `@dokan/contracts`, not re-declared.

Fowler baseline smells — judgement calls, both resolved:

- *Duplicated Code* — the 3-key invalidation array was written twice.
  **Fixed** `1db6fb6`: one `supplierReadQueryKeys` list.
- *Speculative Generality* — `matchByNormalizedName` accepted a nullable
  `accountEntryCount` its only caller never passes. **Fixed** `b0892c7`.
- *Duplicated Code* — `partyNameSchema.name` restated the canonical party name
  constraint. **Fixed** `b0892c7`: `partySchema.pick({ id, name })`.

Judged and kept:

- The two router handlers are passthroughs; that is the repo-wide uniform seam.
- The supplier balance/count aggregate exists in two SQL shapes (correlated
  subquery in `listParties`, `GROUP BY` in the summary). The shared sign
  expression plus the parity test bound the drift risk; unifying them is out of
  scope.

## Residual risks (deferred, not follow-up issues)

- The two reads are not one atomic snapshot; a supplier that gains its first
  entry between the fetches renders `0/0` until the next refetch. The server's
  `OPENING_BALANCE_EXISTS` refusal is the money-path backstop and both keys are
  invalidated after a refusal.
- `submit()` on a failed read returns silently; the form already renders the
  read error, so feedback exists.
- #190 (`feat-184-server-name-resolution`) edits the same files
  (`rpc/router.ts`, `packages/contracts/src/core.ts`, `app-contract.ts`,
  `supplier-opening-balance.tsx`) and is scheduled to **land first** per the
  write-path rule; this branch will rebase onto it. Re-checked `origin/develop`
  during this round: #190 is **not yet merged** (`origin/develop` is still
  `f757211`).
