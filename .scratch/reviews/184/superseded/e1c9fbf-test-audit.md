# Test-audit evidence — #184 review-fix round 1 (PR #190)

- Delta base: `9697611`; code head `179eaf1`; evidence head `e1c9fbf`
- Tier: **High-assurance**
- Agents: edge-case hunter + coverage analyst (`reviewer`) and quality reviewer
  (`oracle`), two passes (at `0f0a6a9` and `a207283`).

## The brief's required tests

| Requirement | Test |
|---|---|
| **1** — a slow lookup + Cancel sends **no write** | web `does not write when the owner cancels while the lookup is pending` — asserts `mutationCalls === 0`, `captured === null`, no saved screen, **and `resolveCalls === 1`**; E2E `cancelling while the name lookup is pending writes nothing` — a route-delayed lookup, then asserts no `suppliersOpeningBalances` POST (`wrote === false`) after the held response. |
| **2** — the edited batch **can** save | web `lets a valid batch save after the typed name moves to another supplier` — dialog closes, no blocked banner, save enabled, both rows wired; E2E `editing the typed name away from the confirmed one keeps the batch saveable` — both balances land (700 / 300). |

Both fail before the fix (proven by reading the pre-fix `9697611` source: no attempt
guard, plain `typedDestination`, no empty-batch guard).

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| E1 | 🔴 | The confirm path didn't re-run the resolved-id conflict; a row edited onto the named account while the dialog was open could post two rows. | **Fixed earlier** (round 0) — `blockedReason`/`totalRows` use `typedNameConflict`; unit test. |
| T1 | 🟠 | Two no-write tests could pass vacuously (`captured === null` alone). | **Fixed**: `mutationCalls === 0` (a write *attempt* counter) and `resolveCalls === 1` positive controls in the cancel, unmount, and typed-edit tests. |
| T2 | 🟠 | No isolated unmount/"page closes" test. | **Fixed**: `does not write when the page unmounts while the lookup is pending` + a browser-back E2E. |
| T3 | 🟠 | The abandon test never proved recovery. | **Fixed**: it re-clicks Save and asserts the corrected batch writes both rows. |
| EC-2 | 🟠 | No typed-field edit during a pending resolve. | **Fixed**: `abandons a pending save when a typed lookup field changes` (+ synchronous handler bumps). |
| EDGE-2 | 🟠 | A refusal after a row edit during the write left a stale dialog → infinite refusal. | **Fixed + tested**: `re-aligns the dialog after a refusal even when a row edit landed during the write` (parked write). |
| EC-7 | 🟡 | The dialog could outlive its rows and confirm an empty batch. | **Fixed**: `save` refuses `totalRows === 0`; unit test `refuses to confirm an empty batch after the last confirmed row is cleared`. |
| T4 | 🟡 | `captured` is a proxy for "write attempted". | **Fixed**: `mutationCalls` counter. |
| T5/EC-7b | 🟡 | `confirmStale` is not asserted in isolation. | **Accepted** — the gate is defence-in-depth; the harness flushes effects inside `act`, and the server's `expectedSupplierId` check is the real backstop. Documented. |
| T6/EC-3 | 🟡 | Edit during the refusal re-resolve untested. | **Partially covered** by EDGE-2's parked-write test; the pure "edit during re-resolve" variant is deferred as defensive. |
| T7/T8 | 🟡 | Inconsistent finding labels; `resolveCalls` was unused. | **Fixed**: labels standardised; `resolveCalls` now asserted. |

## Coverage summary

- web page suite: **33 tests**, all green; the review-round-1 additions are
  cancel / unmount / row-edit-abandon + recovery / typed-edit-abandon / refusal
  re-align / empty-batch / name-moved, each with a positive write-control.
- E2E: 4 new tests (Cancel, back link, browser back, field-edit) — all green in the
  targeted run and in every full run.

## Evidence

- Reviewer transcripts were produced by the test-audit sub-agents for this round;
  the synthesized findings and resolutions are above. Fix commits: `0f0a6a9`,
  `a207283`, `179eaf1`.
