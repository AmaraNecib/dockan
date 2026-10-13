# Debate evidence — #184, server-resolved opening-balance destination

- Base: `origin/develop` @ `da44b502d39c79a1368e9848542d9a25fac301fc`
- Reviewed head: `bb37a1b` (critic + defender), final head `a422880`
- Tier: **High-assurance** (money path — which supplier account receives the amount)
- Roles: `oracle` (harsh critic) + `reviewer` (charitable defender), parallel.

## The core the pair agreed on

- `pickOpeningSupplier` / `resolveOpeningDestination` in
  `apps/api/src/rpc/opening-balance-resolver.ts` is the **only** definition of the
  fold tie-break; both the guarded bulk write (`router.ts`) and the read-only
  `suppliersResolveName` query call it.
- The web page renders `suppliersResolveName`'s answer; `matchByNormalizedName`
  is deleted. The dialog's string is the server's stored text, proven by the
  three-space-vs-two-space web unit test and the E2E balance assertion.
- The full #177 row signature (direction/amount/reason/occurredAt) is part of the
  resolve input, so the resolve reproduces the holder/retry arm too.

## Critic findings and resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | 6 | A draft edited **while the dialog is open** could send a different account than the dialog named. | **Fixed** (`a422880`). The typed row now sends `expectedSupplierId` (the named id, or `null` for new); the server refuses `OPENING_BALANCE_TARGET_CHANGED` when its live resolution differs. Also re-blocks the open dialog when a picked row lands on the named account (client-side `typedNameConflict`). |
| F2 | 6 | Read-resolve vs write TOCTOU; a pre-resolved `confirmExisting: true` skipped the server gate. | **Fixed** by the same `expectedSupplierId` check: the write can only land on the account the dialog named, or it refuses and the client re-resolves and re-opens the dialog. |
| F3 | 5 | `submit` awaited the resolve with no error handling (unhandled rejection, no UI). | **Fixed.** `resolveForSubmit` wraps the read, surfaces `tError`, and returns `undefined` so `submit` aborts; a re-resolve inside the catch cannot mask the original refusal. Name input capped at 200. |
| F4 | 4 | Implementation drifted from the design doc (`useQuery` → `fetchQuery`). | **Fixed.** Design doc updated to the shipped `fetchQuery` + snapshot design. |
| F5 | 4 | The resolved-id conflict was no longer a reactive pre-submit block (#177 round-5 regression). | **Fixed.** `blockedReason`/`totalRows` use `typedNameConflict` (folded name **or** server-resolved id) again; the confirm button disables when blocked. |
| F6 | 3 | The "one place" structural assertion was name-based and narrow. | **Fixed.** The repo-wide scan now also matches `accountEntryCount` comparisons and `Math.max(…entries`; the page assertion rejects any local entry comparator. Still a heuristic guard; the live guarantee is the shared function. |
| F7 | 3 | A conflicting typed row counted toward the row cap, so the wrong message won. | **Fixed.** `totalRows` excludes a conflicting typed row again. |
| F8 | 2 | The E2E `rpc` helper ignored refusals. | **Fixed.** It throws on `!response.ok`. |
| F9 | 2 | The resolver re-reads the full party list; #183 wants a cheaper lookup. | **Noted, not folded in.** `suppliersResolveName` resolves one name to one destination and returns no list; #183 stays a separate follow-up. |
| F10 | 2 | Unused exported types. | Dismissed — the repo exports every inferred contract type by convention. |
| F11 | 2 | Double-submit window around the resolve. | **Fixed.** `resolving` state + `resolvingRef` guard; the save button disables while resolving. |

## Residual (accepted, bounded)

- The `expectedSupplierId` check is the backstop for any drift; after a mismatch the
  client re-resolves and re-opens the dialog. A lost-response retry still surfaces
  `DUPLICATE_ADJUSTMENT` (pre-existing #177 behaviour, unchanged).

## Evidence

- Raw critic/defender output: `.scratch/reviews/184/bb37a1b-debate-raw.{critic,defender}.md`.
- Fix commits: `dbcbef3` (F1–F8, F11), `a422880` (code-review follow-ups).
