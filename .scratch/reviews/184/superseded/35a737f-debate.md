# Debate evidence — #184 review-fix round 2 (PR #190) + rebase

- PR base: `origin/develop` @ `f757211`; delta base `aa9f324` (round-1 head); code head `35a737f`.
- Tier: **High-assurance** (money path — which supplier account receives an amount).
- Roles: `reviewer` (harsh critic) + `oracle` (charitable defender), run in round 2.

## Rebase onto current develop

The branch was rebased from `da44b50` onto the current `origin/develop`:
`bcc586a` (#143/#146/#189/#191) → `d90e000` (#123) → `f757211` (ticket-8 test
fix). One additive conflict in `apps/api/src/rpc/router.ts`:

- **#143 (develop)** added `postStockBatch(tx, specs)` and `postStock(tx, spec)` at
  the spot where the pre-extraction branch had the local `NamedSupplierCandidate`
  type. **Kept both**, at `:216` and `:231`; they are called by all stock-write
  sites (`postStock` ×10, `postStockBatch` at the returns scrap).
- **This branch (#184)** deletes the local type and the inline
  `pickByName`/`signatureHolder`; the resolver module owns them. **Kept the
  extraction**: `import { resolveOpeningDestination, type NamedSupplierCandidate }`
  at `:18`, used at `:1008`, `:1017`, `:1117`; `resolveOpeningDestination` called
  by the guarded bulk write (`:1044`) and the resolve query (`:1121`). No local
  `type NamedSupplierCandidate` declaration remains, and neither helper appears.

Verified by reading the resolved file (grep): no conflict markers; the only
`NamedSupplierCandidate` occurrences are the import + three usages; both
`postStock*` functions present and called. The resolver file is byte-identical to
the pre-rebase branch. `origin/develop` is an ancestor of the head.

## The two Greptile findings

| Finding | Verdict | Resolution |
|---|---|---|
| **1 (money) — a canceled dialog re-opens** | **Confirmed & fixed** | The dialog's Cancel calls `abandonAttempt()` (`supplier-opening-balance.tsx:193`) = `invalidateAttempt()` + `closeConfirm()`, the same primitive as the page `leave()` (`:206`) and the lookup-field effect; `confirm-save` also disables while `resolving`. Cancel stays enabled. |
| **2 — the no-write E2E tests could pass vacuously** | **Confirmed & fixed** | `expectNoWriteDuring` (`tests/e2e/supplier-adjustment.spec.ts:41`) samples every 100 ms for a 1500 ms window, requires `ceil(windowMs/(2*100)) = 8` samples, and is applied to all four leave tests plus the dialog test. |

## Critic findings and resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | 5 | The dialog-Cancel fix was a call site, not the class: an app-shell sidebar nav (no page `onClick`) still relied on the deferred passive unmount cleanup. | **Fixed**: the unmount guard is a `useLayoutEffect` (`:149-153`), whose cleanup runs synchronously in the unmount commit; e2e sidebar test added. |
| F2 | 4 | The refusal-recovery resolve holds `submitting`, so both Cancel buttons are briefly disabled. | **Accepted** — pre-existing and bounded; back link and browser back stay available. |
| F3 | 3 | `resolveKeyRef` lagged the render. | **Fixed**: assigned in a `useLayoutEffect` (`:133-135`), latest-ref pattern. |
| F4 | 3 | `save()` has no re-entrancy guard. | **Accepted** — not reachable from real discrete input; server backstop remains. |
| F5 | 3 | The `resolving` disable on `confirm-save` was untested. | **Fixed**: web test (fails pre-fix). |
| F6-F8 | 3 | `suppliers` refetch mid-resolve; 0-entry refusal loop. | **Accepted** — server `expectedSupplierId` / `OPENING_BALANCE_EXISTS` refusals are the backstop. |
| F9-F10 | 2 | Redundant invalidation; the bounded window is a heuristic. | **Partially addressed / accepted** — documented. |

## Verification

- All fixes confirmed by reading the final files; no remaining write-after-leave or
  stale-value-outliving-an-edit path.
- Mutation checks (pre-fix source): dialog Cancel → web + e2e fail; removing
  `|| resolving` → disable test fails; Escape handler no-op → Escape test fails.
- Guard 1+2 on `35a737f`: `bun run typecheck`/`lint` green; `bun run test`
  **1936 pass / 0 fail** (web 974, api 905, desktop 57); Playwright at
  `DOKAN_PORT=4829 DOKAN_WEB_PORT=5284` **64 pass / 0 fail**.
- Feature-preservation proof: #143 `stock-posting.test.ts` + `router.test.ts`
  **249 pass / 0 fail**; #174 web `party-detail`/`parties`/`query-keys`
  **39 pass / 0 fail** and the 3 e2e pagination tests green in the full run.
- Honest residual: the `useLayoutEffect` timing is not discriminated by a test;
  the sidebar e2e is a path guard. Documented.

## Evidence

- Reviewer transcripts were produced by the debate/test-audit/code-review
  sub-agents for this round; the synthesized findings and resolutions are above.
- Fix commits (pre-rebase): `7815dd7`, `da2e394`, `1997cee`, `c1dd110`; rebased
  series head `35a737f` (base `f757211`).
