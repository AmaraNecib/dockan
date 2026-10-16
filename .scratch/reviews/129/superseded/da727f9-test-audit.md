# Test-audit evidence — issue #129 (PR #209 rebase)

**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop`).
**Reviewed code SHA:** `a24ede713586897798cc35491e7ba91d57b55ea3`.
**Final SHA:** `da727f98bd0cb5cf97c66aaa8b60c743064b23be` (comment correction only).
**Fresh delta:** `04b21e5` (4th spec test + `void refusal.catch` at creation),
`a24ede7` (export `readEnvelope`; `rpcOutput` owns the envelope checks).
Product code unchanged since `0631081`.

Three read-only agents (edge-case hunter, coverage analyst, quality reviewer) ran
on the rebased tree; the parent synthesised and applied the one comment fix.

## The contract the tests pin

`actAndAck` arms the ack, then attaches `void output.catch(() => undefined)`
**before** `await action()`, then returns the original `output`:

```ts
const output = readEnvelope<T>(waitForRpc(page, procedure), procedure);
void output.catch(() => undefined);   // handler at creation
await action();
return output;                        // original promise: still reports the refusal
```

The four `rpc-helpers.spec.ts` tests cover the contract's quadrants:

| Test | Proves |
|------|--------|
| `:61` action error, not a refused RPC, no unhandled rejection | the during-action window is closed; pre-fix this fails with `unhandled rejections: customersCreate failed with HTTP 500` |
| `:104` an action that throws before the armed read is awaited | the spec's own `void refusal.catch` absorbs an abandoned 100 ms wait (fails if that handler is removed) |
| `:142` a refused RPC the action outlives | the early handler did not consume the rejection: `await actAndAck(...)` still rejects with `customersCreate failed with HTTP 500` |
| `:161` an action that throws before its RPC is issued | the removed `try/catch` path still surfaces the action error |

## Edge-case hunter

Highest-value gaps (all non-blocking, carried):

1. **`readRpc` has no focused test** — its non-ok throw, envelope guard and
   `x-vault-session` branch are only exercised indirectly
   (`phone-identity.spec.ts`). 🟠
2. **Envelope guard branch never hit** — no test forces a 2xx body without `json`
   (`rpc-helpers.ts:135`, `:181`). 🟠
3. Empty/204 body makes `response.json()` throw a bare `SyntaxError`, not the
   labelled message (`:125`). 🟡
4. Test 4's comment claims "no leak when the page closes" but asserts nothing. 🟡
   (the handler does prevent it; the test does not observe teardown) 🟡
5. `SETTLE_MS = 50` is a wall-clock heuristic; under CI load the pre-fix defect
   could report after the sleep. 🟠 (retained — the observation is inherently a
   timing signal and 50 ms is far past Node's reporting turn)
6. Process-level `unhandledRejection` listener is worker-wide; an interrupted test
   skips `stop()`. 🟡
7. Test 2 exercises the spec's own handler pattern, not `actAndAck` — deliberate
   (it is the 04b21e5 regression), value documented. 🟡
8. The navigation race is documented and deliberately left to `readRpc`. 🟠
9. `readRpc` accepts any procedure name; an input-requiring procedure sends `{}`
   and gets an opaque 4xx. 🟡

## Coverage analyst

- Acceptance criteria A (numeric rule), B (picker), C (forms): A and B covered.
  **C's supplier *UI* edit is untested** (server side is covered by
  `drizzle-store.test.ts` and `router.test.ts`); `party-forms.test.tsx` mounts
  `role="customer"` only.
- Diversity: unit layers are table-driven and varied; all #129 e2e coverage lives
  in one 4-phase mega-test (`phone-identity.spec.ts`), unlike the repo's usual
  one-behaviour-per-test style.
- Duplicates: `router.test.ts` re-asserts the store's rejection matrix (its unique
  claim is the error-code mapping); Arabic-Indic accept is asserted at six layers;
  the `json` guard is duplicated; `readEnvelope` has no external caller.
- Missing: `readRpc` spec; `rpcOutput` throw branch; the "clear phone to unset"
  UI path; supplier-role form/picker; an API-sourced `INVALID_PARTY_PHONE`
  rendering (the form pre-check intercepts first). `receipts.spec.ts` is a pure
  call-shape refactor with zero new #129 coverage.

## Quality reviewer — grade B

Discriminating where it matters: test 1 awaits the mocked refusal, sleeps past
Node's rejection-report turn, then throws, so the pre-fix "handler-less armed
read" defect surfaces; `refused() === 1` makes the mock self-verifying; `stop()`
and `page.unroute` run in `finally`; test 3 pins the exact message test 1's filter
depends on.

Findings and disposition:

| Source | Finding | Disposition |
|--------|---------|-------------|
| quality | test 1's comment pointed at test 2 for the message pin | **Fixed** at `da727f9` — names the refused-RPC test instead |
| edge/coverage | `readRpc` and the envelope-guard branch untested | deferred (carried from round 2) |
| edge | test 4's comment overclaims teardown coverage | accepted — the comment is aspirational, the assertion covers the action-error path |
| quality | `SETTLE_MS` magic sleeps (`50/100/300`) | accepted — documented heuristics, not derived from one constant |
| quality | test 2 attaches its own handler to the promise it filters | **Accepted** — that is the 04b21e5 regression it exists to pin (fails if the creation-time `void refusal.catch` is removed) |
| coverage | supplier-role form/picker untested | deferred — server path covered; UI parity is a follow-up candidate |
| coverage | one mega-test for #129 e2e | deferred — pre-existing shape, not introduced by this delta |

No fix was required for rebase correctness beyond the comment.

## Residual coverage gaps (non-blocking)

- `readRpc` non-2xx / malformed-envelope throws and its vault-header branch.
- `waitForRpc`'s 30 s timeout path.
- The refusal fixture is a synthetic 500: it pins helper behaviour, not that the
  server refuses.

## Gates (final SHA `da727f9`)

```
bun run typecheck                                            exit 0
bun run lint                                                 exit 0
bun run test        exit 0 (api 913 pass / web 1076 pass / scripts 38 pass; 0 fail)
bun run test:e2e tests/e2e/rpc-helpers.spec.ts               exit 0 (4 passed)
bun run test:e2e    exit 0 (80 passed, 7.9m)
  ports: DOKAN_PORT=4700 DOKAN_WEB_PORT=5700
         DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701
```
