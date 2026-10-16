# Debate evidence — issue #129 (PR #209 rebase)

**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop`).
**Reviewed code SHA:** `a24ede713586897798cc35491e7ba91d57b55ea3`.
**Final SHA:** `da727f98bd0cb5cf97c66aaa8b60c743064b23be` (comment correction only).

A critic and a defender reviewed the rebased diff and the e2e helper read-only;
the parent synthesised the findings below and applied the one comment fix.

## Critic

| # | Severity | Finding |
|---|----------|---------|
| C1 | 6 | Test 1 filters unhandled rejections by substring `"customersCreate"`; only `rpcOutput`'s message produces that text, and its comment pointed at a test that filters `"waitForResponse"`, so the "positive control" was misnamed. |
| C2 | 5 | `actAndAck` starts a second async flow, then installs a permanent silent absorber (`void output.catch`). A design that resolved the envelope internally would not need the Node-unhandled-rejection workaround. |
| C3 | 4 | `SETTLE_MS = 50` and the `setTimeout` sleeps are race windows; under load they can assert before the rejection-report turn. |
| C4 | 4 | `rpcOutput` now hard-requires an own `json` key; a void/204/`{}` procedure makes `response.json()` throw a bare `SyntaxError`, narrowing the helper for unrelated specs. |
| C5 | 4 | `readRpc` issues a second request; its docstring ("this is the server value the UI renders") does not follow, and it hard-codes `/api/rpc/`, `dokan.vault.session`, `x-vault-session`, `body:"{}"` — a parallel client that can drift from `apps/web/src/lib/rpc.ts`. |
| C6 | 3 | Test 2 attaches its own `.catch` to the promise it filters, so it pins Playwright/Node semantics and passes even with the helper's handler removed. |
| C7 | 3 | Process-level `unhandledRejection` listener with `workers: 1` sees other files' rejections; substring filtering is the only guard. |
| C8 | 3 | `cleanPhoneText` before `normalizeAlgerianPhone` is safe only because the latter re-strips — undocumented coupling. |
| C9 | 2 | `readEnvelope` has no caller outside `actAndAck` (dead surface). |
| C10 | 2 | `rpcOutput`'s `procedure = "rpc"` default silently yields "rpc failed" when omitted. |
| C11 | 2 | The `json` envelope check is duplicated at `:135` and `:179`. |
| C12 | 2 | Test 4 runs `signIn` + `/customers` to exercise a branch that needs no page. |
| C13 | 2 | `isPartyPhoneText` accepts arbitrarily long digit runs as an identity key (length bound only). |
| C14 | 2 | `SERVER_ERROR_ALIASES` is a Map for a single alias; the form/picker/store feed different strings into the shared predicate — agreement is incidental. |

## Defender

- **Creation-time handler (`rpc-helpers.ts:60-69`), confidence 9/10.**
  `const output = readEnvelope(...); void output.catch(() => undefined); await
  action(); return output;` is the minimal correct fix. `.catch` derives a new
  promise, so `output` keeps its rejection and the awaited caller still gets the
  refusal — pinned by test 3. Deleting the old `try/catch` loses no path: its only
  job was swallowing the armed read after the action rejected, and the
  unconditional earlier handler is a strict superset.
- **`readEnvelope` / `rpcOutput` composition (`:29-31`, `:118-131`), 8/10.**
  The `.then` on the armed promise fires `response.json()` as soon as headers
  land, shrinking the navigation-discard window without pretending to close it.
  `rpcOutput` adds the `ok()` gate and the envelope-shape guard, so a refusal fails
  loudly and a body without `json` throws instead of returning `undefined`. One
  assertion site now serves `saveQuickAdd` and `receipts.spec.ts`.
- **Exports, 8/10.** `readEnvelope` is the named composition point between "arm"
  and "unwrap"; `readRpc` answers a real failure mode (a mount-time read matched
  across a `goto` yields Playwright's "navigated away from" even with an eager
  read), and mirrors the app's `x-vault-session` header. `actAndAck<T>` now returns
  `T`, removing the `rpcOutput(await actAndAck(...))` nesting.
- **The four tests, 9/10.** They cover the contract's quadrants; the listener is
  scoped by message with the full list in the failure message; the mock is
  self-verifying. The defender re-ran `bunx playwright test
  tests/e2e/rpc-helpers.spec.ts` on the rebased tree: 4 passed.

## Resolution

| Finding | Resolution |
|---------|------------|
| C1 | **Fixed** at `da727f9`: the comment names "the refused-RPC test below" (test 3) instead of test 2. |
| C2 | **Dismissed (defender)** — returning the server output is `actAndAck`'s contract; the handler is required because Node reports an armed promise's rejection unhandled while the action is still running. Reworking to resolve internally would either block the action or change every caller. |
| C3 | **Accepted** — the observation is inherently a timing signal; 50 ms is far past the reporting turn (documented separately). |
| C4 | **Accepted (intended)** — failing loudly on a body without `json` is the point of `rpcOutput`; the `ok()` gate already rejects refusals. |
| C5 | **Accepted, documented** — `readRpc` is a deliberate second request for the navigation-safe read; the docstring states the equivalence argument. Drift from `apps/web/src/lib/rpc.ts` is a real maintenance risk, carried. |
| C6 | **Accepted** — test 2 exists to pin the spec's own creation-time handler (the 04b21e5 defect); it fails if that `void refusal.catch` is removed. |
| C7 | **Accepted, mitigated** — the filter is scoped and test 3 pins the exact message it matches. |
| C8 | **Accepted** — behaviour-preserving; a comment already explains the cleaning split. |
| C9 | **Dismissed (intended)** — the export is the public helper API per `a24ede7`. |
| C10–C14 | **Accepted (minor, carried)** — recorded for a possible follow-up, none merge-blocking. |

No blocker. The only behaviour-neutral change from this debate is `da727f9`'s
comment correction.

## Gates (final SHA `da727f9`)

```
bun run test:e2e tests/e2e/rpc-helpers.spec.ts               exit 0 (4 passed)
bun run test:e2e    exit 0 (80 passed, 7.9m)
  ports: DOKAN_PORT=4700 DOKAN_WEB_PORT=5700
         DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701
```
