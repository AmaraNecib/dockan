# Debate evidence — #184 review-fix round 2 (PR #190)

- Delta base: `aa9f324` (round-1 head); PR base `da44b502`; code head `c1dd110`.
- Tier: **High-assurance** (money path — which supplier account receives an amount).
- Roles: `reviewer` (harsh critic) + `oracle` (charitable defender), first pass at
  `7815dd7`/`da2e394`, then a verification pass at `1997cee`/`c1dd110`.

## The two Greptile findings

| Finding | Verdict | Resolution |
|---|---|---|
| **1 (money) — a canceled dialog re-opens** | **Confirmed & fixed** | The dialog's Cancel now calls `abandonAttempt()` (`supplier-opening-balance.tsx:193`) = `invalidateAttempt()` + `closeConfirm()`, the same primitive as the page `leave()` (`:206`) and the lookup-field effect (`:137-140`); `confirm-save` also disables while `resolving` (`:596`). Cancel stays enabled. |
| **2 — the no-write E2E tests could pass vacuously** | **Confirmed & fixed** | `expectNoWriteDuring` (`tests/e2e/supplier-adjustment.spec.ts:41`) samples the flag every 100 ms for a 1500 ms window, requires `ceil(windowMs/(2*100)) = 8` samples, and is applied to all four leave tests plus the dialog test. |

## First-pass critic findings and resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | 5 | The dialog-Cancel fix was a call site, not the class: an app-shell sidebar nav (no page `onClick`) still relied on the deferred passive unmount cleanup, which a resolve continuation can outrun. | **Fixed**: the unmount guard is a `useLayoutEffect` (`:149-153`), whose cleanup runs synchronously in the unmount commit; e2e `leaving via the sidebar while the name lookup is pending writes nothing` added. |
| F2 | 4 | The refusal-recovery resolve holds `submitting`, so both Cancel buttons are briefly disabled. | **Accepted** — pre-existing and bounded; the back link and browser back stay available. Documented in the design doc residuals. |
| F3 | 3 | `resolveKeyRef` lagged the render (assigned in a passive effect). | **Fixed**: assigned in a `useLayoutEffect` (`:133-135`), latest-ref pattern. |
| F4 | 3 | `save()` has no re-entrancy guard, asymmetric with `submit()`. | **Accepted** — not reachable from real discrete input (React flushes the disabled state synchronously); the server backstop remains. |
| F5 | 3 | The `resolving` disable on `confirm-save` was untested. | **Fixed**: web `disables the confirm button while a re-submit's lookup is pending` (fails pre-fix). |
| F6-F8 | 3 | `suppliers` refetch mid-resolve is not an "edit"; the 0-entry refusal loop. | **Accepted** — the server's `expectedSupplierId` / `OPENING_BALANCE_EXISTS` refusals are the backstop; documented. |
| F9 | 2 | Redundant invalidation across handlers. | **Partially addressed**: `abandonAttempt` unifies dismissal+invalidation at three sites; the synchronous per-keystroke bumps are kept intentionally. |
| F10 | 2 | The bounded window is a heuristic, not a proof. | **Accepted** — documented. |

## Verification pass (at `1997cee`/`c1dd110`)

- All six claimed fixes CONFIRMED by reading the final files; no remaining
  write-after-leave path and no remaining stale-value-outliving-an-edit path found.
- The dialog-cancel web test and the e2e both fail on the pre-fix source
  (temporary revert of the dialog Cancel handler), and `disables the confirm
  button…` fails when `|| resolving` is removed.
- Honest residual: the `useLayoutEffect` timing is not discriminated by any test
  (the held-response tests would also pass on a deferred passive cleanup); the
  sidebar e2e is a path guard, not a discriminator. Documented.
- Accepted residuals: the request is invalidated not aborted; the window is a
  fixed interval; E2E setup duplication is deferred as test-only.

## Evidence

- Reviewer transcripts were produced by the debate/test-audit/code-review
  sub-agents for this round; the synthesized findings and resolutions are above.
- Fix commits: `7815dd7`, `da2e394`, `1997cee`, `c1dd110`.
