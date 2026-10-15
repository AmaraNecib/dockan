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
`JSON.stringify` of the lookup tuple `(name, direction, amount, occurredAt, reason)`;
the destination is only used when `typedResolution.key === resolveKey`. A
`useEffect` on `resolveKey` change additionally **closes the confirmation**,
clears the snapshot, and bumps `attemptRef` (so a submit started for the old fields
cannot land), `confirmStale` hides the dialog for the intervening commit, and the
next submit re-resolves the edited row.

### Follow-ups from the delta reviews (same round)

- **Any batch edit invalidates an in-flight submit**: `invalidateAttempt()` runs
  synchronously in `setRow` and every typed-field `onChange`, so a row filled or
  cleared while the lookup runs cannot be silently dropped from a stale closure.
- **Every leave control invalidates**: `leave()` bumps and closes the dialog; the
  back `<Link>` has `onClick={invalidateAttempt}`; the unmount cleanup bumps too.
- **A refusal re-aligns even after a row edit during the write.** `save` guards the
  recovery re-resolve with the live lookup key (`resolveKeyRef`), not the attempt
  id: a *row* edit must still refresh the dialog, only a *typed-field* edit skips it.
- **The confirm button cannot post an empty batch** after the last row is cleared.

### Added tests

- web (9): cancel during a held lookup writes nothing; unmount during a held lookup
  writes nothing; an existing row edit mid-lookup abandons the stale submit and the
  corrected batch then saves; a typed-field edit mid-lookup abandons it; the dialog
  re-aligns after a refusal that landed after a row edit during the write; an empty
  batch cannot be confirmed; the typed-name-moved flow still saves both accounts;
  positive `resolveCalls`/`mutationCalls` controls pin that the lookup ran and no
  write was attempted.
- e2e (4): route-delayed lookup + Cancel, + back link, + browser back each assert no
  `suppliersOpeningBalances` request follows; the field-edit flow asserts the dialog
  closes, the batch saves, and both balances land.

---

## Review-fix round 2 (PR #190, Greptile 4/5)

Two new findings, both valid; two re-reported round-0 findings verified already
fixed and left untouched.

### Finding 1 — a canceled dialog re-opens

The dialog's own Cancel called `closeConfirm()`, which only hid the dialog and
dropped the snapshot. It did **not** invalidate the in-flight attempt. The
page-level `leave()` fixed in round 1 covered the page Cancel, not this path.

**Repro:** open the dialog for a typed supplier with history, click the main Save
again (a new resolve starts; the dialog stays open), click the dialog's Cancel
while that lookup runs. The attempt was never invalidated, so the late answer
passed the `attemptRef` check and `setConfirming(true)` re-opened the dismissed
dialog.

**Fix:** `abandonAttempt()` — `invalidateAttempt()` then `closeConfirm()` — one
primitive shared by the dialog Cancel, the page Cancel (`leave()`), and the
lookup-field edit effect, so the generation bump and the dismissal cannot drift
apart. Cancel stays enabled (a hung lookup must not trap the owner).
`confirm-save` also disables while `resolving`, so a confirm cannot run against
the snapshot while a re-submit's lookup is still deciding the destination.

**Tests:** web `does not re-open the dialog when its own cancel lands while a
re-submit's lookup is pending` (held second resolve; asserts the dialog stays gone
and `mutationCalls === 0`); web `disables the confirm button while a re-submit's
lookup is pending` (pins the new `resolving` guard); e2e `cancelling the dialog
during a re-submit's lookup does not re-open it` (the second resolve is held on a
gate the test releases *after* the Cancel, then a bounded no-write window and a
dialog-still-gone assertion, plus a real confirmed save as a positive control that
the write listener fires). Both web tests and the e2e fail on the pre-fix source.

### Debate follow-up — the un-instrumented exit (same class as finding 1)

The delta review pointed out that finding 1's fix was a call site, not the class:
the app-shell sidebar and any programmatic route change have no page-level
`onClick`, so they relied on the unmount cleanup, which React runs in a deferred
passive flush that a resolve continuation can outrun.

**Fix:** the unmount guard is now a `useLayoutEffect`, whose cleanup React runs
synchronously in the unmount commit — before any microtask scheduled by the
resolve can run — so any exit that unmounts the page invalidates first. This
covers the sidebar and programmatic nav without the page needing router APIs. The
back link keeps its own `onClick` as an immediate second guard.

**Test:** e2e `leaving via the sidebar while the name lookup is pending writes
nothing`; the round-1 web unmount test and the browser-back e2e cover the same
guard.

### Skill-guided hardening

- **Vercel React `advanced-use-latest`.** `resolveKeyRef` is now synced in a
  `useLayoutEffect` (latest-ref pattern) instead of the passive effect that did
  the reset, so a late continuation reads the key of the render on screen rather
  than the previous commit.
- **TanStack Query.** `fetchQuery` is kept rather than `ensureQueryData`
  (`pf-ensure-query-data`): the resolve must be the server's live answer, and
  `ensureQueryData` returns cached-stale data that could name the wrong account.
  `query-cancellation` is deliberately not applied: the generation guard already
  prevents any effect, aborting an oRPC call logs `AbortError` through the rpc
  interceptor, and aborting the held request would break the leave E2E tests that
  release the response after the page is left.
- **Web Interface Guidelines / accessibility.** The confirmation dialog closes on
  Escape (`onKeyDown`), the keyboard equivalent of its Cancel, reusing
  `abandonAttempt` so an in-flight submit is invalidated too. Unit test:
  `cancels the open confirmation on Escape`.

### Finding 2 — the no-write E2E tests could pass vacuously

`wrote` starts `false`, so `expect(wrote).toBe(false)` — and even
`expect.poll(...).toBe(false)`, which returns on its first `false` sample — could
pass before the page's continuation ran. The response was awaited, but not the
continuation.

**Fix:** the spec shares `expectNoWriteDuring(page, wrote, windowMs = 1500)`: it
samples the flag every 100 ms for a fixed window, asserts every sample `false`,
and requires `ceil(windowMs / 200)` samples so the window cannot be skipped.
Applied to all four leave tests (Cancel, back link, browser back, sidebar).

### Re-reported findings 3 & 4 — verified already fixed at round 1

- **"Cancel still writes balances"** — the page Cancel (`leave()`,
  `supplier-opening-balance.tsx:206`), the back `<Link>`
  (`onClick={invalidateAttempt}`, line 374) and the synchronous layout-effect
  unmount cleanup (line 149) all invalidate. Tests: web `does not write when the
  owner cancels while the lookup is pending`, `does not write when the page
  unmounts while the lookup is pending`; e2e `cancelling while the name lookup is
  pending writes nothing`, `leaving via the back link while the lookup is pending
  writes nothing`, `browser back while the name lookup is pending writes
  nothing`. The only residual was the dialog's Cancel — finding 1 above — fixed
  now.
- **"Old destination blocks valid edits"** — `typedDestination` is keyed by
  `resolveKey` (line 111), `confirmStale` hides the dialog for a mismatched key
  (line 115), and the `resolveKey` effect (lines 137-140) drops the snapshot and
  invalidates the attempt. Tests: web `lets a valid batch save after the typed
  name moves to another supplier`; e2e `editing the typed name away from the
  confirmed one keeps the batch saveable`. No residual path found; not
  re-implemented.

### Accepted residuals (dismissed, documented)

- The resolve request is invalidated, not aborted; a late result is discarded.
- The `useLayoutEffect` unmount guard narrows the un-instrumented-exit window to
  the unmount commit but does not eliminate it (React still schedules the
  commit); no test discriminates the layout-effect timing, and the round-2 E2E
  suite is deliberately wall-clock for the four leave paths.
- The refusal-recovery resolve still holds `submitting`, so the two Cancel
  buttons are briefly disabled; the back link and browser back stay available.
- A `suppliers` list refetch mid-resolve is not an "edit" and does not bump the
  attempt; the server's `expectedSupplierId` / `OPENING_BALANCE_EXISTS` refusals
  are the backstop.
- The bounded window is a fixed interval, not a proof; a write after the window
  would still be missed.
- The four no-write E2E tests share ~15 lines of route/listener setup; extracting
  a fixture is deferred as test-only duplication.

---

## Rebase onto develop (#143, #146, #189, #191, #123)

The branch was rebased from its `da44b50` base onto `origin/develop` (`bcc586a`,
then `d90e000` after #123 merged, then `f757211` after the ticket-8 test fix). One additive conflict in
`apps/api/src/rpc/router.ts`:

- **#143 (develop)** added `postStockBatch(tx, specs)` and its length-one
  `postStock(tx, spec)` at the spot where the pre-extraction branch had the local
  `NamedSupplierCandidate` type. **Both kept** and called by every stock-write
  site.
- **#184 (this branch)** deletes the local type and the inline
  `pickByName`/`signatureHolder`; the resolver module owns them. **Kept the
  extraction**: `import { resolveOpeningDestination, type NamedSupplierCandidate }`
  from `./opening-balance-resolver`, used by the guarded bulk write and the
  resolve query.

Verified by reading the file: no local `type NamedSupplierCandidate` declaration;
the only occurrences are the import and three usages; `resolveOpeningDestination`
is called at both sites; no `pickByName`/`signatureHolder`; the resolver file is
byte-identical to the pre-rebase branch. `origin/develop` is an ancestor of the
rebased head.

Guard 1+2 on the rebased head: `bun run test` 974 pass / 0 fail; full Playwright
64 pass / 0 fail on isolated ports (4829/5284). Feature preservation: #143
`stock-posting.test.ts` + `router.test.ts` 249 pass; #174 web 39 pass + the 3 e2e
pagination tests.

---

## Rebase round 2 onto develop (#197, #193, #202)

The branch was rebased from base `f757211` onto `origin/develop` @ `21dbc13`
(which took #197's e2e failure evidence, #193/#202's configurable vault ports and
load-proof 201-supplier test). One conflict, in
`apps/web/src/pages/supplier-opening-balance.test.tsx` — the same test file both
sides edit; every other file auto-merged. Git stopped twice, both inside that one
file, on this branch's round-4 commits.

- **develop (#202/#193)** added `setNativeValue`, the batched `fillAmounts`
  helper and the named `BATCH_LIMIT_TEST_TIMEOUT_MS`, and converted both
  batch-limit tests (200-row and 201-supplier) to `fillAmounts`. **Kept**: the
  merged file uses develop's single fill helper and named budget for both tests.
- **this branch** had rewritten the file across rounds 1–4 (the `clickTarget` /
  `clickOn` / `dispatchClickOn` helpers, `NEW_TAB_ACTIVATIONS`, the five new-tab
  cases, the plain-click control and the `target="_blank"` case). **Kept** in
  full; `modifiedClickOn` is absent because this branch's own next commit
  (`76ac83e`) had already replaced it.

Verified by reading the merged file: a single fill helper; both batch-limit tests
carry `BATCH_LIMIT_TEST_TIMEOUT_MS`; all seven round-4 new-tab tests present. The
file diff against the pre-rebase branch is exactly develop's #202 additions, so
no test was dropped or weakened. `origin/develop` is an ancestor of the rebased
head.

Guard 1+2 on the rebased head: `bun run typecheck` 0, `bun run lint` 0,
`bun run test` 986 pass / 0 fail, full Playwright 64 pass / 0 fail on isolated
ports (api/web 5417/6273, vault 4599/5274). Both proof sets pass in one run: the
200-row and 201-supplier load-proof tests (1204 ms / 1124 ms) and the seven
round-4 new-tab cases.
