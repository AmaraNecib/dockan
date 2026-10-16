# 91 — code review (two axes)

Base: `a52084d` (origin/develop). Reviewed diff: `a52084d...cf136f9`, rebased
onto the final head `1037618` (test-only).

Ran as two parallel sub-agent reviews (Standards, Spec). Findings and how each
was resolved.

## Standards

Findings:

1. **Gate evidence must live in `.scratch/reviews/<id>/<sha>-*.md`** — resolved:
   this file.
2. **Middle Man**: `const BROKER_TIMEOUT_MS = HEAVY_TEST_TIMEOUT_MS;` was a
   meaningless alias — resolved: alias dropped, the 9 broker tests use
   `HEAVY_TEST_TIMEOUT_MS` directly, the rationale moved to the file doc.
3. **Duplicated Code**: the same comment + `setDefaultTimeout(HEAVY_TEST_TIMEOUT_MS)`
   block in four wire-test files — resolved: `test-support/heavy.ts` now exports
   `setHeavyDefaultTimeout()`; the four files call it once.
4. **Inconsistent idiom**: `lock.integration.test.ts` passed the budget
   positionally while sibling heavy files used `itHeavy` — resolved: both tests
   are `itHeavy`.
5. **Hook coverage**: only `beforeAll`-with-`setup()` was budgeted. Checked the
   remaining hooks: `encrypted-connection`, `encrypted-store`, `manager`,
   `port-record` `beforeEach`/`beforeAll` only `mkdtemp`; the heavy work is in
   the test bodies (budgeted).
6. `lock.integration.test.ts` had no trailing newline — resolved.

Judgement calls accepted: `itHeavy` is a one-line wrapper over `it`, which is
the point (a named budget).

## Spec

Findings:

1. **Audit may be partial** (some files still leave plain `it(` on tests). The
   first fix added the one missed file, `vault/core.test.ts` (production KDF,
   1.2s warm). A later full `bun run test` then caught the real cost of a partial
   audit: two `parties (issue 120)` tests in `drizzle-store.test.ts` (shared
   store, no legacy-DB token in the body) timed out at 5000ms. Resolved by
   making the whole `drizzle-store` file and `encrypted-connection` uniform
   (`setHeavyDefaultTimeout`), not by patching the classifier again.
2. **Second-half cascade asserted, not demonstrated** — it is an audit result:
   `backups.test.ts` is already per-test; the other shared dirs hold one live DB
   and use distinct file names. No diff change is expected.
3. **`runA/B.log` show 1 fail** — those are the **pre-fix** 3-suite baselines
   (21:55, before any change); the failure was the whole-repo scan test at
   exactly 5000ms. Post-fix contended runs are `final2-*`, `v3-*`, `v4-*` and
   `gate-postgap.log`.
4. **Scope creep** — accepted and justified:
   - `.gitignore` `.scratch/*-logs/`: keeps the lane's run logs out of the tree
     (they are evidence, not source).
   - `vault/broker` + `lock.integration` 30s → shared budget: a broker test hit
     the old 30s bound under a contended run and failed; the issue's acceptance
     is that the suite passes contended, and this is genuinely heavy work
     (process + Argon2).
   - `vault/gate` + `vault/manager`: vault integration suites whose tests run
     real Argon2 + snapshot IO. The one pure test in `manager` stays `it(`.
5. **Evidence mismatch** (doc cited `final2-*` / `v2-*` that were not in
   `.scratch/91-logs/`) — resolved: logs copied into `.scratch/91-logs/`,
   `v2-*` replaced by `v3-*` / `v4-*`, doc paths corrected.
6. **`setDefaultTimeout` gives light tests a long budget** — reworded: the
   strict default is kept for pure-logic *files* and the trivial tests inside
   mixed files; the uniform files are database/vault work.
7. **`session-secret` 15s → shared budget** — intentional: one heavy budget, and
   the cross-process test is heavy.
8. **`itHeavy` drops `.skip`/tag overloads** — cosmetic; no caller uses them.

## Post-review decisions (from running the full gate)

- **120s, not 60s.** Under `bun run test` (turbo runs api + web together) with
  sibling worktrees active, `parties (issue 120) > backfills one party per
  distinct typed name…` (four `setup()` calls) was measured at **96s** and blew
  a 60s budget. 120s still bounds a real hang.
- **`drizzle-store` + `encrypted-connection` use `setHeavyDefaultTimeout`** so a
  test the token-based audit misses cannot regress.

Summary: Standards 6 findings, all resolved (worst: duplicated
`setDefaultTimeout` blocks). Spec 8 findings, all resolved or accepted with
rationale (worst: the stale log paths, then the partial-audit gap the full gate
exposed and this head fixes).
