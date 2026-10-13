# #183 — code-review evidence (two axes)

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `da44b502d39c79a1368e9848542d9a25fac301fc`
- **Head:** `3f814b13fdb96fd0578b3151804b6b55ad095e1f`
- **Commits:** `f590c32` (implement), `45ae313` (failed-read gate + invalidation),
  `2594889` (dialog gate + contract `.pick` + tighten), `d7e1663` (invalidation
  list), `3f814b1` (read-key array resolved at render)
- **Verdict:** Spec — pass. Standards — pass with two judged notes.

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
  **Fixed** `d7e1663`: one `supplierReadQueryKeys` list.
- *Speculative Generality* — `matchByNormalizedName` accepted a nullable
  `accountEntryCount` its only caller never passes. **Fixed** `2594889`.
- *Duplicated Code* — `partyNameSchema.name` restated the canonical party name
  constraint. **Fixed** `2594889`: `partySchema.pick({ id, name })`.

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
- #184 edits the same page and still references `suppliersList`; it must rebase
  onto this branch (the parent owns landing).
