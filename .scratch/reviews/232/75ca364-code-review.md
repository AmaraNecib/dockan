# Code review — #232 Greptile round

- **Reviewed SHA:** `75ca3645fabd9cea3ca0e5337a4db52a9ce442c9` (`75ca364`)
- **Standards/Spec fixed point:** `7934fea` (PR head before this round); full PR base `origin/develop` @ `1ea76b5`
- **Diff:** `7934fea...75ca364` — `apps/api/src/store/encrypted-store.test.ts` (3 insertions / 3 deletions)
- **Tier:** Standard (test-only)
- **Reviewers:** two independent, read-only sub-agents (`Standards` + `Spec`)

## Standards

No hard violations.

- Both converted tests now take the budget from the single shared definition
  (`apps/api/src/test-support/heavy.ts`, `HEAVY_TEST_TIMEOUT_MS = 120_000`). No private timeout
  constant or literal was introduced; the only `it` import was removed, and `it` is no longer
  referenced (all 7 tests are `itHeavy`).
- Test-file-only, no production change; staging used named paths (no `git add -A`).
- Judgement call (optional, **not fixed**): the two converted tests repeat the slow-`serialize`
  monkey-patch preamble nearly verbatim; a `withSlowSerialize(conn, ms)` helper would remove the
  copy. Pre-existing shape, outside this round's finding — left deliberately.

## Spec

All requirements met; no scope creep; nothing implemented wrong.

| Requirement (brief / Greptile) | Verdict |
|---|---|
| Both outlier tests take the budget (`itHeavy` or file default) | Yes — `encrypted-store.test.ts:235`, `:260` |
| File left uniform, not two patched outliers | Yes — all 7 tests `itHeavy`, one mechanism |
| No production change | Yes — test file only |
| No new private timeout constant | Yes — shared `heavy.ts` only |
| Whole PR swept for the same miss | Yes — 25 test files, 119 `itHeavy`, 0 unbudgeted heavy |

Notes (evidence quality, not defects): the two files using the explicit third-arg carrier
(`vault/broker.test.ts`, `rpc/supplier-account-zero.test.ts`) are budgeted but their "OK" is weaker
evidence under the sweep's first pass; both were re-checked manually and confirmed on
`HEAVY_TEST_TIMEOUT_MS`. The purity of the light tests was checked by reading each plain `it`.

**Summary:** Standards — 0 hard violations, 1 optional duplication judgement call; Spec — 5/5
requirements met, 0 findings. No blocker.
