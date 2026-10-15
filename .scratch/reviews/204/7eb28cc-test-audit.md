# #204 — Test-audit evidence (delta round 2)

Head reviewed: `7eb28cc23d1c88bcd5e97ea923ecd90613c4c8e4`
Delta scope: `2ea36e8...7eb28cc`
Base: `8a7a7fa35de501efee15a802430193003926633d`
Method: independent edge-case/coverage/quality review of the changed tests;
full affected file run **61 pass / 0 fail** (`cd apps/web && bun test
src/pages/supplier-opening-balance.test.tsx`).

## Coverage of the two findings

| Requirement | Status | Evidence |
|---|---|---|
| F1 write-time guard is exercised by a test that fails without it | covered | Reducing `removalBlocksSave()` to `return removedFilledRef.current.length > 0` fails the rewritten race test: `captured` holds the removed `gone` row (`mutationCalls === 1`). |
| F1 test exercises the failing ordering (cache fresh, effect uncommitted) | covered | `setQueryData` writes the fresh names list synchronously; React Query schedules the re-render/effect on a macrotask, and the held lookup is released in the same tick, so `save()` reads the fresh cache before the effect commits. |
| F1 test is dependable evidence (not timing-luck) | covered | **25/25 green under 4 CPU burners.** The first version used a real `invalidateQueries` and was load-flaky (6/6 failures under load when a reviewer ran it); rewritten to remove that nondeterminism. |
| F2 reset test reaches `presentSupplierIds === null` with filled drafts | covered | Asserts `opening-balance-loading` and no `opening-balance-removed` while `namesHold` holds the replacement read, with a filled `100` row and a typed `50` row in state. |
| F2 reset test fails without the reset guard | covered | Removing `if (presentSupplierIds === null) return;` makes the notice render (it sits outside the pending ternary) and the `amount === "100"` / save assertions fail. |
| F2 typed amount remains and can be saved after release | covered | After release, the row input is `"100"` and the save posts `keep:100` + `newSupplierName:"..." :50`. |

## Findings and disposition

| Finding | Disposition |
|---|---|
| Race test load-flaky (real refetch write could lose to the resumed lookup under load) | **Fixed** — deterministic `setQueryData`; 25/25 under load. |
| Race test lacked the "loss is surfaced" assertion | **Fixed** — asserts `opening-balance-removed` after the blocked write. |
| Reset with a **changed** replacement list (null window → replacement missing a filled supplier) | **Deferred**: the finding asked for the reset-held window only; the identical-list replacement still proves the guard (the null window must not flag drafts). The changed-list path is the normal refresh case, already covered by the other `#204` removal tests. |
| Save clicked *during* the null window | **Accepted**: `totalRows === 0` while `suppliers` is empty, so `submit` refuses with the existing "nothing entered" guard; the loading state replaces the table. No data-loss path. |
| `void queryClient.resetQueries(...)` relies on `settle()`'s macrotask ticks | **Accepted**: `settle()` explicitly drains three `setTimeout(0)` ticks; the test passed every run, and `beforeEach` resets the hold. |
| Unfilled-row removal, multi-removal, dialog-close-on-removal | already covered by existing `#204` tests (unchanged). |
| Removing the typed new row | N/A — typed rows live in `newName`/`newAmount`, not keyed by supplier id. |

## Grades

- Rewritten race test: **A** — deterministic, discriminating (verified against a
  reverted gate), and asserts both the refusal and the surfaced loss.
- Reset-held test: **A** — provably reaches the `null` window and fails without
  the guard; asserts recovery and saveability.
- Unchanged `#204` removal tests: **A-**.

## Verdict

Both findings have driving tests that fail without their fix. The only material
defect the audit found (race-test flakiness) is fixed and stress-verified. The
one uncovered variant is documented and non-blocking.
