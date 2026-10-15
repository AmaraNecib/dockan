# Test-audit evidence — #184 review round 5 (PR #190)

- Head under audit: **`04ae4e7`** (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). Delta audited: the
  round-5 timing fix to the no-write window.
- Method: three read-only reviewer sub-agents (edge-case hunter, coverage
  analyst, quality reviewer) over `tests/e2e/no-write-window.ts`,
  `tests/e2e/no-write-window.spec.ts`, and `expectNoWriteDuring` + its 5 call
  sites in `tests/e2e/supplier-adjustment.spec.ts`.

## The question the brief asked: *would this still catch a real write?*

**Yes.** The quality reviewer drove the real module and latched a write at
0/50/700/1400/1490 ms into a 1500 ms window; every offset threw. The loop only
breaks *after* a `check`, so there is no unchecked trailing gap, and `wrote` is
a sticky flag. The fix changes only *when the assertion may stop*, never
whether a detected write propagates.

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| T1 | 🟠 | The `samples >= minSamples` clause was untested: no case reached "window satisfied, count short". Removing the clause still passed all tests. | **Fixed + proven.** Added `keeps sampling past the window when the sample count is still short` (700 ms gap > 600 ms window). Temporarily deleting the clause makes exactly that test fail (`samples` stops at 2 < 3). |
| T2 | 🟠 | A `wait` that never yields can starve the event loop, so a real request handler never sets `wrote` → false PASS. | **Fixed.** The sampler now yields (`setTimeout(0)`) before every sample, so a non-yielding `wait` cannot hide a write. Production `page.waitForTimeout` already yielded; this closes the latent trap. |
| T3 | 🟡 | A write caught late reported the *previous* sample's elapsed time (stale diagnostic). | **Fixed.** `observedMs` is recomputed before each `check`. |
| T4 | 🟡 | Post-loop `expect(wrote())` rationale ("last sample precedes the final wait") was false — the loop breaks immediately after a check. | **Fixed.** Comment corrected; the read is kept as belt-and-braces. |
| T5 | 🟡 | `Date.now()` is not monotonic; a forward jump could end the window early. | **Fixed.** Switched to `performance.now()`. |
| T6 | 🟡 | `sampleMs?` / `minSamples?` options were never passed by any caller (speculative surface). | **Fixed.** Removed; the policy is one internal constant plus a derived floor. |
| T7 | 🟡 | New spec header said "no app, no database", but the global `webServer` boots for the whole `testDir`. | **Fixed.** Reworded to "no page, no fixtures". |
| T8 | 🟡 | No test of a write landing *during a slow* gap. | **Fixed.** Added `a real write during a slow gap still fails the sampler`. |
| T9 | 🟡 | First test's `expect(observedMs).toBeGreaterThanOrEqual(0)` was vacuous. | **Dropped.** |

## Deadline-vs-count check elsewhere in the PR

Only `expectNoWriteDuring` had the shape. `vault.spec.ts` `waitForOk` /
`waitForVaultState` use a `Date.now()` deadline but have **no minimum-count
assertion** (poll-until-condition, timeout only for the negative case), so they
do not share the defect. `preferences.test.tsx` `waitFor` is a fixed-attempt
poll-until-true that returns `false` to fail — same correct shape.

## Round-5 proof matrix

| Proof | Where | Result |
|---|---|---|
| Existing pass case still passes | 5 `expectNoWriteDuring` call sites in `supplier-adjustment.spec.ts` | **pass** |
| Deliberately slowed sampler PASSES | `no-write-window.spec.ts` slowed case; and the same test re-run against the OLD deadline logic | new **pass**; old **fail** (`2 < 3`) |
| REAL write inside the window still FAILS | `no-write-window.spec.ts` two controls (fast gap + slow gap) | **pass** (both reject) |
| Count floor still binds | count-gate test; temporarily drop `&& samples >= minSamples` | **pass**; clause removed → **fail** |

## Verification at `04ae4e7`

- `bun run typecheck` → **0** (3 tasks).
- `bun run lint` → **0**.
- `bun run test` → **0**; web **986 pass**, api **905 pass**, desktop **59 pass**.
- `DOKAN_PORT=5617 DOKAN_WEB_PORT=6373 DOKAN_VAULT_PORT=4699 DOKAN_VAULT_WEB_PORT=5374 bun run test:e2e`
  → **exit 1**: **60 passed**, 3 unrelated specs failed, vault's 6 skipped as
  collateral. A same-port rerun of exactly those specs
  (`00-onboarding`, `learnability`, `vault`) → **15 passed / 0 failed**. The
  failures are scheduler flakes under four concurrent sibling lanes (the suite
  took 13.8 m vs 6.8 m isolated); the failing set changed between runs and
  `supplier-adjustment.spec.ts` + `no-write-window.spec.ts` were green in every
  run.
