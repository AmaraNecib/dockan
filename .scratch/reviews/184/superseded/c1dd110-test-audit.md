# Test-audit evidence — #184 review-fix round 2 (PR #190)

- Delta base: `aa9f324`; code head `c1dd110`; tier: **High-assurance**.
- Agents: edge-case hunter + coverage analyst (`reviewer`) and quality reviewer
  (`oracle`), first pass, then a verification pass.

## The brief's required tests

| Requirement | Test |
|---|---|
| **1** — the dialog's own Cancel must not let a late lookup re-open it | web `does not re-open the dialog when its own cancel lands while a re-submit's lookup is pending` — holds the second resolve, cancels, releases, asserts the dialog stays gone and `mutationCalls === 0`; e2e `cancelling the dialog during a re-submit's lookup does not re-open it` — the second lookup is held on a gate released **after** the Cancel (causal, not wall-clock), then a bounded no-write window, then a real confirmed save as a positive control for the write listener. Both fail on the pre-fix source. |
| **2** — no write over a bounded window for all three leave tests | `expectNoWriteDuring(page, wrote, windowMs=1500)` applied to Cancel, back link, browser back, sidebar, and the dialog test. |

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| T1 | 🟠 | The e2e dialog test used a 1500 ms route delay, so a loaded CI could cancel after the resolve and pass pre-fix. | **Fixed**: the second lookup is held on a promise gate released only after the Cancel; `lookups >= 2` is the positive control. |
| T2 | 🟠 | The `resolving` disable on `confirm-save` had no test. | **Fixed**: web `disables the confirm button while a re-submit's lookup is pending` (asserts false→true→false; fails without `|| resolving`). |
| T3 | 🟠 | No positive control that the write listener fires. | **Fixed**: the dialog e2e ends with a real confirmed save and asserts `wrote === true`. |
| T4 | 🟠 | The helper's minimum sample count was a hard-coded 5 with an unused `windowMs` param. | **Fixed**: derived `ceil(windowMs / (2 * sampleMs))`. |
| T5 | 🟡 | The sidebar e2e is wall-clock and does not discriminate the `useLayoutEffect` change. | **Accepted, documented** — it is a path guard; the design doc states the timing is not discriminated. |
| T6 | 🟡 | E2E setup duplication (~15 lines × four tests). | **Deferred** — test-only; documented in the design doc residuals. |
| T7 | 🟡 | `expect.poll(...).toBe(false)` returned on the first sample. | **Fixed** by the bounded-window helper (round 2, finding 2). |
| T8 | 🟢 | Escape-to-cancel had no test. | **Fixed**: web `cancels the open confirmation on Escape` (fails when the handler is a no-op). |

## Verification

- Web suite: **864 pass / 0 fail** (`bun run test`). E2E: **62 pass / 0 fail**
  (`DOKAN_PORT=4829 DOKAN_WEB_PORT=5284 bunx playwright test --workers=1`).
- Mutation checks: reverting the dialog Cancel handler fails the web test and the
  e2e; removing `|| resolving` fails the disable test; making the Escape handler a
  no-op fails the Escape test.
- The pre-existing cross-file `mock.module("@tanstack/react-router")` leak that
  broke the AppSidebar tests is fixed by spreading the real module in
  `routerMock` (dashboard had the same fix).

## Evidence

- Reviewer transcripts were produced by the test-audit sub-agents for this round;
  the synthesized findings and resolutions are above. Fix commits: `7815dd7`,
  `da2e394`, `1997cee`, `c1dd110`.
