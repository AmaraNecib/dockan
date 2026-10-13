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
- `resolveOpeningDestination(candidates, row, signatureHolds)` — first candidate
  already holding the row's #177 signature (a retry), else `pickOpeningSupplier`.
  Both arms now live here; the write path and the resolve query call the same
  function.

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
- `useQuery(orpc.suppliersResolveName, …)` keyed on the typed row when it is ready
  (name + positive amount + valid date). `typedDestination` = the server response.
- `typedNameConflict` uses **only** the server id (plus the local folded-name
  check, which is not the tie-break).
- `namedRowNeedsConfirm` / `confirmNames` / the dialog name all come from
  `typedDestination.name` (fallback to the typed name only when the server says
  `null` = new).
- `submit` awaits `ensureQueryData` for freshness, re-checks the resolved-id
  conflict, then opens the dialog or saves.
- The `OPENING_BALANCE_EXISTS` catch re-resolves (`resolve.refetch()`) after
  invalidating the supplier list, so the re-opened dialog names the refreshed
  destination.

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
