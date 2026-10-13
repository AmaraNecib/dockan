# #184 — Expose name resolution instead of mirroring the server tie-break

Tier: **High-assurance** (money path — which supplier account receives the amount).
Base: `origin/develop` @ `da44b502d39c79a1368e9848542d9a25fac301fc` (== HEAD here, no local commits yet).
Branch: `feat-184-server-name-resolution`.

## Problem

#177/#180 made the server the only *writer* resolver of a typed supplier name.
But `apps/web/src/pages/supplier-opening-balance.tsx` still re-implements the
server's fold tie-break (`matchByNormalizedName`: entry-carrying party, then
lowest id) to name the destination in the opening-balance confirmation dialog and
to guard a resolved-id collision. Two copies of one rule → the dialog can name an
account the server will not write to.

## Decision

The server exposes its resolution; the client renders it. Exactly one
implementation of the rule, in `apps/api`.

### New server module — the single implementation

`apps/api/src/rpc/opening-balance-resolver.ts`:

- `type NamedSupplierCandidate = { id; name; entries }`
- `pickOpeningSupplier(candidates)` — the tie-break: most entries, then lowest id.
  **The only definition in the repo.**
- `resolveOpeningDestination(candidates, signatureHolds)` — the candidate already
  holding the row's #177 signature (a retry; lowest id when two match), else
  `pickOpeningSupplier`. Both arms now live here; the write path and the resolve
  query call the same function.

### New procedure — `suppliersResolveName`

- Input: `{ name, direction, amount, occurredAt, reason? }` (the row signature, so
  the resolve can reproduce *both* arms of the server's rule).
- Output: `{ supplier: { id, name, accountEntryCount } | null }`; `null` = no
  supplier folds to the name, a write would create one.
- Read-only. Reads `listParties("supplier")`, filters by `normalizeTextKey`, calls
  `resolveOpeningDestination` with `hasSupplierAdjustment` for the holder arm.

### Write path

`suppliersOpeningBalances` stops defining its own `pickByName` / `signatureHolder`
and calls `resolveOpeningDestination`. Behaviour unchanged.

### Client

- Delete `matchByNormalizedName`.
- `resolveTypedDestination()` reads `suppliersResolveName` through
  `queryClient.fetchQuery` on demand (submit, and again after a refusal), so the
  dialog never renders a locally-computed fold. The result is held in a
  `typedDestination` state snapshot: the dialog names exactly what that read
  returned. The snapshot is cleared when the dialog closes.
- `typedNameConflict` uses **only** the server id (plus the local folded-name
  check, which is not the tie-break).
- `namedRowNeedsConfirm` / `confirmNames` / the dialog name all come from
  `typedDestination.name` (fallback to the typed name only when the server says
  `null` = new).
- `submit` awaits the resolve (with a `resolving` guard and an error surface),
  re-checks the resolved-id conflict, then opens the dialog or saves.
- The typed row also sends `expectedSupplierId` (the named id, or `null` for
  "new"). The server never uses it as the write target; it refuses with
  `OPENING_BALANCE_TARGET_CHANGED` when its own live resolution differs. This
  closes the draft-edited-while-the-dialog-was-open window and the
  resolve-to-write race: the amount can only land on the account the dialog
  named, or the save refuses and re-resolves.
- The `OPENING_BALANCE_EXISTS` / `OPENING_BALANCE_TARGET_CHANGED` catch
  re-resolves after invalidating the supplier list, so the re-opened dialog names
  the refreshed destination.

## Contract

```ts
supplierResolveNameInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  direction: supplierAdjustmentDirectionSchema,
  amount: dinarsSchema.refine((v) => v > 0),
  occurredAt: localDateTimeSchema,
  reason: z.string().trim().max(500).nullable().optional(),
});
supplierResolveNameOutputSchema = z.object({
  supplier: z.object({ id: idSchema, name: z.string(), accountEntryCount: z.number().int().min(0) }).nullable(),
});
```

`supplierOpeningBalanceRowInputSchema` gains an optional
`expectedSupplierId: idSchema.nullable()`: the destination the dialog named
(`null` = new). The server compares it with its own live resolution and refuses
`OPENING_BALANCE_TARGET_CHANGED` on a mismatch.

## Planned tests

### Unit / API (`apps/api`)

1. `opening-balance-resolver.test.ts` — the pure tie-break: most entries wins;
   equal entries → lowest id; empty → undefined. **Structural assertion** that the
   web page no longer defines the rule (`matchByNormalizedName` absent; no
   `accountEntryCount` comparison).
2. `router.test.ts` — with two suppliers folding to one name:
   - `suppliersResolveName` returns the entry-carrying one and
     `suppliersOpeningBalances` writes to that same id (both sides in one test).
   - both empty → the lowest id; fresh name → `null`.
   - a name that folds onto an account already holding the row's signature
     resolves to that account (holder arm).
   - users still can pick the explicit `supplierId` sibling.

### Web (`apps/web`)

3. `supplier-opening-balance.test.tsx` — the dialog renders the name returned by
   `suppliersResolveName`, including a name that differs from the typed string
   (proves it comes from the server, not a local fold). The existing opening-balance
   tests stay green, including the raced confirm-after-refresh flow (now refreshed
   via the resolve query).

### E2E (`tests/e2e`)

4. `supplier-adjustment.spec.ts` — create two suppliers folding to one name, give
   one an entry, type the folded name on the bulk screen, and assert the dialog's
   named account is the account that receives the amount after confirm.

## Risks

- Async resolution can race the save. Mitigated: `ensureQueryData` before deciding,
  and the existing refusal→refresh→re-confirm path as backstop.
- The `holder` arm makes the resolve depend on the row signature; the query takes
  the full signature so it cannot disagree with the write.
- #183 (names-only lookup) is **not** included; this query resolves one name to one
  destination and returns no list.

---

## Review-fix round 1 (PR #190, Greptile 4/5)

Two findings, both valid; the first is money-critical.

### Finding 1 — Cancel still writes balances

`submit` awaited `resolveForSubmit()` and then unconditionally reached
`save(false, destination)`. The main Cancel button was enabled while the lookup ran
and only navigated, so a late resolve could post the batch after the owner left.

**Fix:** a monotonic `attemptRef`. Every `submit` owns `attempt = ++attemptRef.current`
and returns without writing when `attempt !== attemptRef.current` after the await.
`leave()` (the Cancel handler) bumps the attempt before navigating, and an unmount
effect bumps it too (any route out of the screen). Cancel stays **enabled** and is
never blocked on `resolving` — a hung lookup must not trap the owner. Late results
also skip their `setError`/`setResolving` via `mountedRef`.

### Finding 2 — The old destination blocks valid edits

`typedDestination` outlived a field edit: after changing the typed name from A to a
different supplier B while the confirmation was open, the duplicate check still
compared against A and disabled both save buttons.

**Fix:** the snapshot is now `typedResolution = { key, supplier }`. `resolveKey` is
the serialized lookup tuple `(name, direction, amount, occurredAt, reason)`; the
destination is only used when `typedResolution.key === resolveKey`. A `useEffect`
on `resolveKey` change additionally **closes the confirmation**, clears the
snapshot, and bumps `attemptRef` (so a submit started for the old fields cannot
land), and the next submit re-resolves the edited row.

### Added tests

- web: cancelling a held lookup writes nothing (mock resolve gate); editing the
  name to another supplier then filling the old row's row leaves the save enabled
  and writes both accounts.
- e2e: a route-delayed `suppliersResolveName` + Cancel asserts no
  `suppliersOpeningBalances` request follows and the name never materializes; the
  field-edit flow asserts the dialog closes, the batch saves, and both balances land.
