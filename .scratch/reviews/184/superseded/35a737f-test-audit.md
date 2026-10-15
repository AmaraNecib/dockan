# Test-audit evidence — #184 review-fix round 2 (PR #190) + rebase

- PR base: `origin/develop` @ `f757211`; delta base `aa9f324`; code head `35a737f`.
- Tier: **High-assurance**. Agents: edge-case hunter + coverage analyst
  (`reviewer`) and quality reviewer (`oracle`).

## Rebase

Rebased onto the current `origin/develop` (`bcc586a` → `d90e000` → `f757211`); one
additive conflict in `apps/api/src/rpc/router.ts` resolved by keeping both
`postStockBatch`/`postStock` (#143) and the #184 extraction (imported
`NamedSupplierCandidate`, dropped the local type). Verified by grep and by the
suites below.

## The brief's required tests

| Requirement | Test |
|---|---|
| **1** — the dialog's own Cancel must not let a late lookup re-open it | web `does not re-open the dialog when its own cancel lands while a re-submit's lookup is pending` (holds the 2nd resolve, cancels, releases, asserts dialog stays gone + `mutationCalls === 0`); e2e `cancelling the dialog during a re-submit's lookup does not re-open it` — the 2nd lookup is held on a gate released **after** the Cancel (causal), then a bounded no-write window, then a real confirmed save as a positive control for the write listener. Both fail on the pre-fix source. |
| **2** — no write over a bounded window for all three leave tests | `expectNoWriteDuring(page, wrote, windowMs=1500)` applied to Cancel, back link, browser back, sidebar, and the dialog test. |

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| T1 | 🟠 | The e2e dialog test used a 1500 ms route delay, so a loaded CI could cancel after the resolve and pass pre-fix. | **Fixed**: the 2nd lookup is held on a promise gate released only after the Cancel; `lookups >= 2` is the positive control. |
| T2 | 🟠 | The `resolving` disable on `confirm-save` had no test. | **Fixed**: web `disables the confirm button while a re-submit's lookup is pending` (fails without `|| resolving`). |
| T3 | 🟠 | No positive control that the write listener fires. | **Fixed**: the dialog e2e ends with a real confirmed save and asserts `wrote === true`. |
| T4 | 🟠 | The helper's minimum sample count was a hard-coded 5. | **Fixed**: derived `ceil(windowMs / (2 * sampleMs))`. |
| T5 | 🟡 | The sidebar e2e is wall-clock and does not discriminate the `useLayoutEffect` change. | **Accepted, documented** — path guard only. |
| T6 | 🟡 | E2E setup duplication (~15 lines × four tests). | **Deferred** — test-only; documented. |
| T7 | 🟡 | `expect.poll(...).toBe(false)` returned on the first sample. | **Fixed** by the bounded-window helper. |
| T8 | 🟢 | Escape-to-cancel had no test. | **Fixed**: web `cancels the open confirmation on Escape` (fails when the handler is a no-op). |

## Verification

- `bun run test` → **1936 pass / 0 fail** (web 974, api 905, desktop 57).
- Full Playwright at `DOKAN_PORT=4829 DOKAN_WEB_PORT=5284` → **64 pass / 0 fail**.
- #143 preserved: `apps/api` `stock-posting.test.ts` + `router.test.ts` →
  **249 pass / 0 fail** (the movement-posting seam still backs every stock write).
- #174 preserved: web `party-detail.test.tsx`/`parties.test.tsx`/`query-keys.test.ts`
  → **39 pass / 0 fail**; the 3 e2e `pagination.spec.ts` tests green in the full run.
- Mutation checks: reverting the dialog Cancel fails web + e2e; removing
  `|| resolving` fails the disable test; a no-op Escape handler fails its test.
- The pre-existing cross-file `mock.module("@tanstack/react-router")` leak that
  broke the AppSidebar tests is fixed by spreading the real module in `routerMock`.

## Evidence

- Reviewer transcripts were produced by the test-audit sub-agents; the synthesized
  findings and resolutions are above. Fix commits: `7815dd7`, `da2e394`,
  `1997cee`, `c1dd110`; rebased head `35a737f` (base `f757211`).
