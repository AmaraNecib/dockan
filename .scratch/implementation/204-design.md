# #204 — Never silently drop a filled opening-balance draft when its supplier vanishes

Tier: **High-assurance** (money-entering screen; the failure mode is a silent loss of the
owner's typed figure).
Base: `origin/develop` @ `8a7a7fa35de501efee15a802430193003926633d` (== HEAD).
Issue: #204 (surfaced by #183's test-audit; pre-existing behaviour).

## Problem

`apps/web/src/pages/supplier-opening-balance.tsx` keeps the owner's amount drafts in
`drafts: Record<supplierId, RowDraft>` state, but renders rows from the fresh
`suppliers` list that React Query hands back on every refetch. When a background
refresh (another instance, or a delete elsewhere) removes a supplier, the row
unmounts while its draft stays in state, unreferenced. A **filled** amount is
therefore dropped with no message — the owner can reasonably believe it will be
saved.

## Decision

**Flag it visibly AND block the save until the owner acknowledges**, at the refresh
seam. Not block-forever: a genuine deletion must stay recoverable, so the notice
names the supplier + amount and carries one dismiss action that re-enables the
save. Not flag-only either: on a money screen a banner the owner can miss is still
a silent drop, so an unacknowledged removal disables Save.

Why not block-only: a supplier that is really gone can never be restored from this
screen, so a permanent block traps the owner and pushes them to reload and lose
*all* other drafts. Why not silently keep the orphan draft: it would resurface if
the id ever came back and would re-warn on every subsequent refresh.

Mid-typing: the draft is already in state as the owner types, so `openingRowStatus`
sees a partially typed amount and the same notice fires; an empty (untouched) row
still drops silently, which the negative test pins.

## Seam

The reconciliation is a pure function in `apps/web/src/lib/supplier-opening-draft.ts`
(where `openingRowStatus` already lives), called from one effect that runs when the
fresh supplier id set changes — **not** in the render layer:

```ts
export type RemovedFilledDraft = { supplierId: string; name: string; amount: number };

export function droppedFilledDrafts(input: {
  drafts: Readonly<Record<string, { name?: string; amount: string }>>;
  presentSupplierIds: readonly string[];
}): RemovedFilledDraft[];
```

It reuses `openingRowStatus`, so "filled" has exactly one definition. To name the
supplier after it is gone, the draft records the name it was typed against
(`RowDraft` gains `name`, seeded by `setRow` from the live row) — the same
snapshot-of-identity idea as #184's `expectedSupplierId`.

## Page behaviour

- `presentSupplierIds` is memoised from `suppliers`; one `useEffect` on it reads the
  latest drafts from a ref, calls `droppedFilledDrafts`, appends the result to
  `removedFilled` state (deduped by id) and deletes those keys from `drafts`.
- `removedFilled.length > 0` renders a `role="alert"` notice
  (`data-testid="opening-balance-removed"`), one line per removed row
  (`opening-balance-removed-row`) naming the supplier via
  `supplierOpeningRemovedRow` and rendering the amount through `<Amount>`, plus a
  dismiss button (`opening-balance-removed-dismiss`).
- While `removedFilled.length > 0`, Save is disabled and both `save()` and
  `submit()` refuse with `supplierOpeningRemovedBlocked`; dismiss clears the notice
  and unblocks.
- The existing `blockedReason` is unchanged; the removal notice is its own,
  named banner so the owner sees *which* supplier and *what* amount was lost.

## i18n (Arabic keys, no hardcoded strings in code or tests)

- `supplierOpeningRemovedTitle`
- `supplierOpeningRemovedRow` (`{{name}}`)
- `supplierOpeningRemovedBlocked`
- `supplierOpeningRemovedDismiss`

## Tests

- **Pure** (`supplier-opening-draft.test.ts`): a filled orphan is returned with its
  remembered name + parsed amount; an untouched orphan returns `[]`; a present
  supplier returns `[]`; several orphans keep input order.
- **Page** (`supplier-opening-balance.test.tsx`), the acceptance sequence:
  fill row → refetch removes that supplier → the notice names the supplier and
  renders its amount, Save is disabled, and `requestSubmit()` writes nothing
  (`captured === null`, `mutationCalls === 0`). Dismiss re-enables Save and a
  subsequent save sends only the surviving rows.
- **Page negative**: an untouched row whose supplier vanishes on the same refetch
  produces no notice (so ordinary refreshes stay quiet).
- **E2E** (`tests/e2e/supplier-adjustment.spec.ts`): create a no-entry supplier via
  RPC, open the bulk screen, fill its row, delete the supplier via RPC, dispatch
  `visibilitychange` to trigger React Query's window-focus refetch, then assert the
  named notice is visible and Save is disabled; dismiss → Save enabled.
- Assertions use `i18n.t(...)`, not literal Arabic.

## Risks

- **False positive on a transient empty list.** React Query keeps `data` across a
  refetch, so `suppliers` never momentarily empties; reconciliation keys off id-set
  changes only.
- **StrictMode double effects.** The mount double-invoke sees empty drafts, so no
  spurious notice.
- **A partial read failure** already blocks Save (`listFailed`), so it cannot look
  like a removal.
- **Invalid drafts** (e.g. `0`, `abc`) are out of scope per the issue; only a
  positive parsed amount is "filled". Noted, not silent-blocked by this change.

## Out of scope

- The server write path: the batch never referenced the deleted id, so no change.
- An explicit refresh button: refetch-on-focus is the existing mechanism.

## Review round 1 (debate + test-audit + code-review)

Adversarial review found one real hole and several cheap hardenings, all applied:

- **The block must be live, not captured.** `save`/`submit` can resume after the
  render that started them, so a removal landing during the in-flight name lookup
  could post the removed row. `removalBlocksSave()` reads `removedFilledRef` at
  write time, and the reconciliation effect calls `abandonAttempt()` when it drops
  anything — the same stale-closure class Greptile round 3 fixed for `listFailed`.
- **A removal closes the confirmation it invalidated** (`abandonAttempt`).
- **`presentSupplierIds` is `null` until the list loads**, so a cache reset cannot
  read as "every supplier vanished".
- **a11y**: the `role="alert"` live region wraps the statement only; the dismiss
  button sits outside it.
- **Copy**: `supplierOpeningRemovedRow` says "what you wrote in its row was not
  saved", which stays true for a mid-typing partial figure.
- **Tests added**: removal during the in-flight resolve, removal with the
  confirmation open, two removals in one refresh, a failed refetch never flagging a
  phantom removal, the `supplierOpeningRemovedBlocked` copy, and the nameless-draft
  fallback.

Deferred (non-blocking): a re-entry affordance/hint (the owner can retype the
amount in the inline new-supplier row) and flagging *invalid* orphan drafts
(`0`/`abc`), which the issue scopes out.
