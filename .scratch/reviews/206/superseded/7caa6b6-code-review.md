# #206 — code review (head 7caa6b6)

Two-axis review of `git diff 3c3abcf...HEAD`, plus a focused delta review of
`b92d687..7caa6b6` after the round-1 findings were applied.

## Standards

Documented-standard checks:

- **unslop §13 (no em dashes).** Round 1 flagged the em dashes in the new
  `docs/ci.md` paragraph and in the new wisdom file. **Fixed**: both reworded to
  sentences. Pre-existing em dashes elsewhere in `docs/ci.md` are untouched.
- **writing-for-agents (single source of truth).** `docs/ci.md` restates
  "(defaults `4399`/`5174`)", a third copy after `AGENTS.md` and the resolver.
  **Dismissed**: the manual-procedure section is operational and the reader needs
  the numbers inline; the resolver remains the code source of truth.
- Extraction removed the duplicated parser from `vault.spec.ts` and kept the
  defaults and error text byte-identical to the shipped `vaultPort()`.

Baseline smells:

- Duplicated Code, the rejection loop's twin `it()` bodies: **dismissed**, each
  pins a distinct variable and message; a table would hide the variable name in
  the generated test title.
- Data Clumps, `resolvePort(env, name, fallback)`: **dismissed**, three call sites
  with an explicit, readable signature.
- No Mysterious Name, Feature Envy, Repeated Switches, Shotgun Surgery, Message
  Chains, Middle Man, or Refused Bequest. `resolveVaultPorts` is the requested
  seam, not a Middle Man.

## Spec

| Brief item | Verdict |
|---|---|
| 1. Extract the resolver + unit-test defaults/blank/out-of-range | **Done.** `packages/e2e-support/src/vault-ports.ts` + 22 tests. |
| 2. `backups.spec.ts` reads `E2E_DATA_DIR` | **Done**, textually identical to `playwright.config.ts:16`, so a relative value resolves the same way. Default run passes; a custom-dir run passes and writes there. |
| 3. Concurrent vault runs: automate only if deterministic, else say so and stop | **Done.** No racy test. `docs/ci.md` documents the manual procedure; the KDF-contention signature and the STOP rationale are recorded; wisdom captured. |
| Defaults byte-for-byte 4399/5174 | **Verified** in code and in a test that asserts the literals. |
| No timeout increases | **Verified**: no timeout value changed anywhere in the diff. |
| No app/contract/schema change | **Verified**: diff is `tests/e2e/*`, `packages/e2e-support/*`, `docs/ci.md`, `.agents/wisdom/*`, `bun.lock`, `.scratch/*`. |

Spec notes, not blockers:

- The manual procedure's "both must exit 0" was never observed green in this
  environment: two concurrent runs both timed out at test 3's 5 s post-KDF
  assertion under load. The brief's STOP clause covers this; the doc states the
  contention signature and tells the operator to use an idle host.
- The negative-control signature is stated but was not re-measured for #206.

Scope creep, justified: the new workspace package plus its `bun.lock` entry (the
only way `tests/e2e` logic can run under `bun run test`), and the wisdom file.

## Delta review (`b92d687..7caa6b6`)

Independent agent verdict: **PASS**, no blockers.

1. `toThrow(new Error(msg))` pins the message exactly in bun:test; the expected
   strings match `vault-ports.ts` (verified by the reviewer and by a probe).
2. `0x10 → 16` and `1e3 → 1000` match `Number()` semantics and stay in range;
   `apps/api/src/config.ts` parses `DOKAN_PORT` with `Number()` too.
3. No new em dashes; the reworded sentences have no factual regression; the
   design-doc base rewrite (`3c3abcf`, first draft `21dbc13`) is accurate.
4. Non-blocking notes only: `new Error` matches the message, not the error type;
   the wisdom sentence is a mild run-on after em-dash removal; the new test
   formalises permissive parsing as intended contract.

## Verdict

Standards: pass after the em-dash fixes. Spec: pass. Delta: pass. No blocker.
