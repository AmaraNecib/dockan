# #179 — Code review evidence (Standards + Spec)

- **Reviewed HEAD:** `aa2cbe8d553267025d986e749805a1a3c8d4cafc`
- **Base:** `8bf2a817a2d25a58653704f1c4c15542bd822cc2`
- **Diff:** `git diff 8bf2a817a2d25a58653704f1c4c15542bd822cc2...aa2cbe8d553267025d986e749805a1a3c8d4cafc`
  → `tests/e2e/rpc-helpers.ts` (new), `tests/e2e/receipts.spec.ts`,
  `tests/e2e/arabic-search.spec.ts`, `.scratch/implementation/179-design.md`
- **Method:** two parallel read-only sub-agents, one per axis.

## Standards

**Hard violations: none found in the code.** Tooling (`oxlint`, `tsc`) is green.

- Helper matches the repo's recorded wire contract
  (`.agents/wisdom/2026-08-24-deterministic-timing-tests.md` pt 3): the matcher
  is POST + exact `pathname === /api/rpc/${procedure}`.
- Follows `playwright-best-practices/debugging/flaky-tests.md`
  ("Async/Timing Flakiness" — arm `waitForResponse`, then act) and avoids the
  `waitForTimeout` / global-timeout-bump anti-patterns; `playwright.config.ts`
  is untouched.
- Implements wisdom `2026-08-24-stock-ledger-t27.md` pt 4 (scope assertions to
  your own row) in `arabic-search.spec.ts`.

**Judgement calls:**

| Finding | Decision |
|---|---|
| *Speculative Generality*: `waitForRpc`/`expectRpcOk` exported but only used internally. | **Accepted** — documented helper API in the design. |
| *Primitive Obsession*: `procedure: string` bypasses the typed contract; a typo surfaces as a 30 s timeout. | **Accepted** — Playwright cannot import the oRPC client types in the test runner here; the procedure names are asserted by the passing specs. |
| `expect(resolved.ok()).toBe(true)` instead of `toBeOK()`. | **Accepted** — the custom message names the procedure and status. |
| `waitForRpc` does not match the request body. | **Accepted as residual** — no overlapping request in these specs. |
| Evidence-file naming (`<head-sha>-<gate>.md`). | **Fixed** — this file set is named for `aa2cbe8`. |

## Spec

**Requirements: all satisfied; acceptance (d) satisfied for the affected specs.**

- **(a) Stable spec-scoped signal.** receipts drops the 5 s `toContainText("INV-")`
  poll for `actAndAck("invoicesCreate")` and asserts the server-issued
  `invoiceNumber` (`/^INV-\d+$/`) plus the card. arabic-search acks every
  `itemsCreate`/`customersCreate` write and every `catalogSearch` read, and
  scopes results to the spec's own `resultRow`. No timeout value increased.
- **(b) Cross-spec search dependence.** Assertions no longer read the aggregate
  `search-results` list; they target the stamped row. Residual truncation at
  `DEFAULT_CATALOG_LIMIT = 20` is documented and accepted (no category filter in
  the contract; app change out of scope).
- **(c) The race verdict is stated.** Design §Root cause: **no app race was
  found**. receipts — no app race, the test polled a 5 s window for a server
  round-trip; arabic-search — no app race, the test raced its own unacknowledged
  writes, and the empty state is the correct render for a query whose matching
  row is not committed yet.
- **(d) Acceptance evidence.** Recorded (see `aa2cbe8-acceptance.md` and the raw
  logs): affected specs ×3 green (workers 1), full suite 3× green at the shipped
  `workers: 1` (53 passed each), affected specs `--workers=2 --repeat-each=3`
  green (6 passed), plus two controlled 10 s-delay experiments.
- **Scope creep:** none. Two specs + one shared helper + the design doc. No app,
  config, or suite restructuring.

**One flagged limitation:** the full suite at `--workers=2` is red — two
first-run setup races (`00-onboarding.spec.ts:104`, `vault.spec.ts:166`). That
mode is documented as unsupported (`playwright.config.ts` ships `workers: 1`
because all specs share one SQLite DB and race first-time setup) and the issue
scope forbids suite restructuring, so it is out of scope; both changed specs
passed in that run.

## Verdict

Standards: 0 hard violations. Spec: all requirements satisfied; the only
literal acceptance gap is the unsupported full-suite parallel mode.
