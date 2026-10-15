# #206 — test audit (head 7caa6b6)

Base: `origin/develop` `3c3abcf`. Three review agents (edge-case hunter, coverage
analyst, quality reviewer) ran against `b92d687`; round-2 fixes were applied and
a focused delta review confirmed them at `7caa6b6` (see
`7caa6b6-code-review.md`). Change under audit: the new
`packages/e2e-support/src/vault-ports.test.ts` (22 tests), the resolver it covers,
`tests/e2e/backups.spec.ts`, and the vault.spec import.

## Edge-case hunter

| # | Finding | Risk | Disposition |
|---|---------|------|-------------|
| 1 | `api === web` collision never rejected: the resolver accepts `DOKAN_VAULT_PORT=DOKAN_VAULT_WEB_PORT`, so two servers fight for one port | medium | **Dismissed, out of scope.** #202's shipped `vaultPort()` did not reject it and the brief requires parsing to stay byte-for-byte as shipped. The pair is a test-harness concern; a collision fails the vault spec loudly at the health poll. |
| 2 | Blank `E2E_DATA_DIR` is not "unset": `??` yields `""` and a relative `backups/` | medium | **Dismissed.** `playwright.config.ts:16` and `00-onboarding.spec.ts:45` use the identical `??` fallback, so `backups.spec.ts` *matches* the convention the brief asks it to follow. A truly blank value makes `scripts/wipe-e2e.mjs` throw first. Diverging here would break config/spec agreement. |
| 3 | Documented `Number()` aliases (hex/exponent) untested; a `parseInt`/regex refactor would drift silently | medium | **Fixed.** Added "parses with Number(), so hex and exponent strings resolve as numbers" (`0x10` → 16, `1e3` → 1000). |
| 4 | No test pins which variable's error wins when both are invalid | low | **Dismissed.** Object-literal order is an implementation detail, not a contract. |
| 5 | `undefined` value / trailing newline in the raw string unexercised | low | **Dismissed.** `resolveVaultPorts({})` already exercises the `undefined` branch; `Number()` trims and the whitespace test covers the trim path. |
| 6 | Vault pair is not asserted to differ from the shared pair | low | **Dismissed, out of scope.** That is spec configuration, not the resolver; the shared pair is `DOKAN_VAULT=disabled` so a collision fails visibly. |

## Coverage analyst

| Spec criterion | Test | Status |
|---|---|---|
| Defaults pinned (4399/5174) | `pins the historical defaults` | covered |
| Blank-means-unset | `treats blank and whitespace-only values as unset` | covered |
| Out-of-range rejection | 14 `rejects ... by name` tests | covered |
| Concurrent vault suites both exit 0 | none | gap by decision (brief §3 overrides the issue); documented in `docs/ci.md` |
| `backups.spec.ts` honours `E2E_DATA_DIR` | code only, **no automated env-set branch** in the unit suite | **proven by a targeted e2e run**, not a unit test |

Diversity: 14 of 22 are the rejection loop (two per value), defensible because the
name-in-message assertion carries real signal; the positives are varied.
Duplicates: none worth removing.

Additional gaps noted: the spec↔resolver seam is not asserted (dropping the
import would keep unit tests green — but the full e2e run exercises the import);
and the `E2E_DATA_DIR` truthy branch was never run automatically.

**Resolutions.** Seam: covered by Guard 2. Env-set branch: covered by
`DOKAN_PORT=4873 DOKAN_WEB_PORT=5873 E2E_DATA_DIR=$PWD/.e2e-data/206-custom
bun run test:e2e tests/e2e/backups.spec.ts` → 1 passed, with the backup written
under `.e2e-data/206-custom/backups`. AC2 (concurrent runs) stays manual per the
brief.

## Quality reviewer

Grade **B+**. Names state behaviour; no async issues; global-state isolation is
correct (both vars saved and restored in `finally`; no await in the body, so it
cannot interleave at `--max-concurrency=2`); the package wires into turbo
correctly. Two actionable items were fixed:

1. **`toThrow(string)` is substring matching in Bun, so the message was not
   pinned.** Proven: a probe throwing `"XXabcYY"` passes `toThrow("abc")`.
   **Fixed** to `toThrow(new Error(...))`, with a comment stating why; also
   asserts `Error` type.
2. **Doc/runtime drift risk on hex/exponent.** **Fixed** by the new test above.

Dismissed as minor/out of scope: a `withEnvVars` helper for `restoreEnv`
duplication; extracting the third copy of the `E2E_DATA_DIR ?? ".e2e-data"`
expression; the incidental `.dokan-port` modification (**restored before
commit**).

## Result

22 unit tests pass / 0 fail; the one systemic weakness (substring assertions) and
the doc/runtime drift are fixed; all remaining findings are dismissed with the
reason above. No blocker.
