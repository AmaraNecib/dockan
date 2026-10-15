# Code-review evidence — #184 review round 5 (PR #190)

- Head reviewed: **`04ae4e7`** (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). Two-axis review
  (Standards + Spec) by parallel read-only sub-agents.
- **Debate waiver (round 5):** not re-run. The parent brief scoped this to a
  small test-timing fix and named test-audit as "the valuable one"; the change
  touches no product code-path, so the adversarial design debate has no new
  surface. Debate evidence from `81a337d` (moved to `superseded/`) still covers
  the implementation under test.

## Change under review

- `tests/e2e/no-write-window.ts` (new): `sampleNoWrite` samples until BOTH
  `observedMs >= windowMs` AND `samples >= minSamples`, measures from the first
  sample on `performance.now()`, yields before each sample, propagates a
  throwing `check`.
- `tests/e2e/no-write-window.spec.ts` (new): 5 isolated proofs.
- `tests/e2e/supplier-adjustment.spec.ts`: `expectNoWriteDuring` delegates.

## Standards axis

Sources: `AGENTS.md`, `docs/engineering-workflow.md`,
`docs/development-workflow.md`, oxlint + tsc, Fowler smell baseline.

| # | Finding | Resolution |
|---|---------|------------|
| S1 | *Mysterious Name* (judgement call): module `no-write-window` vs export `sampleNoWrite`. | **Accepted.** The module names the scenario it implements; the export names the action. Renaming is cosmetic and would churn the import for no gain. |
| S2 | Header comment "no app, no database" was inaccurate (global `webServer` boots anyway). | **Fixed** — reworded to "no page, no fixtures". |
| S3 | Duplicated `wait: (ms) => new Promise(...)` in tests 1–2. | **Declined** — the `*5` variation *is* the test; extracting would obscure it. |
| S4 | `expectNoWriteDuring` is a thin adapter (*Middle Man*). | **Kept** — it binds `page.waitForTimeout` and appends the final read; not a pure pass-through. |
| S5 | Hard violation: `M .dokan-port` (tracked generated port record). | **Fixed** — reverted before commit; e2e runs rewrite it, so it is never staged. |

No hard documented-standard violations.

## Spec axis

Spec source is `D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-184-greptile-round5.md`
(outside this worktree; the sub-agent could not read it, so the parent verified
these directly).

| # | Requirement | Status |
|---|-------------|--------|
| P1 | Keep sampling until BOTH elapsed window AND minimum count hold | **met** (`observedMs >= windowMs && samples >= minSamples`) |
| P2 | Window measured in OBSERVED time, not wall-clock before the first sample | **met** — clock starts at the first sample; `performance.now()` |
| P3 | Existing pass case still passes | **met** — 5 call sites green |
| P4 | Deliberately slowed sampler now PASSES | **met** — durable test + old-code cross-check (`2 < 3`) |
| P5 | REAL write inside the window still FAILS | **met** — two controls (fast + slow gap) |
| P6 | Check other helpers with the same shape | **met** — only `expectNoWriteDuring` had it; vault helpers are deadline-only polls |
| P7 | Small diff | **met** — 2 files + 1 new module + 1 proof spec |

Scope creep found: `.dokan-port` (reverted) and unused options `sampleMs` /
`minSamples` (removed). No missing or wrong requirements.

## Verification at `04ae4e7`

- `bun run typecheck` → **0** (3 tasks); `bun run lint` → **0**.
- `bun run test` → **0** (web 986 / api 905 / desktop 59).
- Full e2e on the isolated quad → 60 passed, 3 unrelated contention flakes
  (untouched specs), 6 vault skips as collateral; rerun of those specs → **15
  passed / 0 failed**. Details in `04ae4e7-test-audit.md`.
- `git status` clean after commit except the new `.scratch` evidence.
