# Test-audit evidence — #184

- Base: `da44b502d39c79a1368e9848542d9a25fac301fc`
- Audited head: `dbcbef3`; findings closed by `0860f3d` and `a422880` (final head).
- Tier: **High-assurance**.
- Agents: edge-case hunter + coverage analyst (`reviewer`) and quality reviewer
  (`oracle`), parallel.

## Acceptance → test map (all met)

| Acceptance criterion | Test |
|---|---|
| Dialog destination comes from the server | web `renders the server-resolved destination name, not the typed text`; E2E `a folded opening-balance name lands on the supplier the dialog names` |
| Tie-break exists exactly once | `opening-balance-resolver.test.ts` structural scan + page assertion |
| Dialog names the supplier the server writes to, two folded names, both sides in one test | api `resolves a typed name to the same supplier the opening-balance write lands on` (asserts resolved id **and** name == write result); E2E asserts balance 800 on the named account and 0 on the twin |
| Existing opening-balance tests stay green | web 26/26, api `issue 176` subset 9/9 |
| Structural assertion the client no longer re-implements it | resolver test + page source assertions |

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| E1 | 🔴 | The confirm path never re-ran the resolved-id conflict: editing a row onto the dialog's named account while the dialog was open could post two rows to it. | **Fixed** (`a422880`). `blockedReason`/`totalRows` use `typedNameConflict` (folded name or server-resolved id); the confirm button disables; test `re-blocks the open dialog when a row is edited onto the named account`. |
| E2 | 🟠 | `expectedSupplierId = <id>` while the live resolution is `undefined` (a rename) untested. | **Fixed.** api test `refuses when the named account no longer folds to the typed name`. |
| E3 | 🟠 | The holder arm's tie-break was array-order dependent when two candidates both hold the signature. | **Fixed.** `resolveOpeningDestination` now picks the lowest id among holders; unit test `is order-independent when two candidates both hold the signature`. |
| E4 | 🟠 | The resolve-failure arm (`resolveForSubmit` → `undefined`) untested. | **Fixed.** web test `writes nothing and surfaces the error when the resolve read fails`. |
| E5 | 🟠 | The `resolving` double-click guard unasserted; same-task double fire could pass the stale closure. | **Fixed.** added `resolvingRef` synchronous guard. (Kept as robustness, not a dedicated test.) |
| E6 | 🟠 | The `OPENING_BALANCE_TARGET_CHANGED` catch (re-resolve + reopen) untested. | **Fixed.** web test `re-resolves and re-opens the dialog when the named destination moved`. |
| E7 | 🟡 | A failed re-resolve was overwritten by the outer `setError`, leaving a stale dialog. | **Fixed.** the original refusal is surfaced first; a re-resolve failure overwrites it with the actionable error. |
| E8 | 🟡 | Save count included a conflicting typed row. | **Fixed** by the E1 change (`totalRows` excludes conflicts). |
| E9 | 🟡 | `suppliersResolveName` boundaries untested. | **Fixed.** api test `rejects a whitespace-only resolve name and a zero amount, and folds surrounding whitespace`. |
| E10 | 🟡 | No test that resolve is read-only / not called on the no-typed-name path. | Read-only is covered by the fresh-name `null` test writing nothing on the twins; no-typed-name call count is trivial. Accepted as a note. |
| E11 | 🟡 | No positive `expectedSupplierId: null` create test. | **Fixed.** api test `accepts expectedSupplierId: null when the name is genuinely new`. |
| E12 | 🟡 | The web mock keyed the resolve on the name only. | **Fixed.** the mock key now includes the whole row signature. |
| E13 | 🟡 | The structural guard was evadable via a differently-named comparator. | **Partially fixed.** regex broadened to `accountEntryCount` comparisons and `Math.max`; documented as heuristic (the live guarantee is the shared function + the E2E/api assertions). |
| E14 | 🟡 | `resolveOpeningDestination`'s `row` parameter was unused. | **Fixed.** parameter removed; interface is now `(candidates, signatureHolds)`. |
| E15 | 🟡 | E2E breadth (drift, null destination, id conflict through the real API). | Accepted — unit/component/api cover these; the E2E keeps the highest-value end-to-end divergence assertion. |
| E16 | 🟡 | A lost-response retry still surfaces `DUPLICATE_ADJUSTMENT`. | Pre-existing #177 behaviour; out of scope, noted. |

Quality reviewer grade: **B → A** after E1–E6/E12/E14 and the assertion/name
cleanups (quality #4 `expectedSupplierId` in the raced test, #7 name equality in
the api same-supplier test, #10 testid-based error assertion).

## Evidence

- Raw outputs: `.scratch/reviews/184/dbcbef3-test-audit-raw.{edge,coverage,quality}.md`.
- Fix commits: `0860f3d`, `a422880`.
