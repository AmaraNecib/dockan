# Test-audit evidence — issue #129 (round 3 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `2db1b35a01f3919a06eb5c57109ee8c7a6eab0d1`.
**Round-3 commits:** `b5515da` (handler before the action + spec), `0279269`
(scope the unhandled-rejection assertion), `2db1b35` (wisdom).
**Code under review is unchanged from `0279269`; `2db1b35` adds only the wisdom
entry. Product code unchanged since `0631081`; the round-3 delta is
`tests/e2e` + `.agents/wisdom`.**

## The finding

`actAndAck` armed the ack **before** running the action, but the armed read kept
no rejection handler until the action settled (the old `try/catch` attached
`void output.catch(...)` only after `await action()` rejected). If the server
refused the RPC **while the action was still in flight**, that refusal rejected
unhandled — a second failure that can bury the action's own error.

## Fix

```ts
const output = readEnvelope<T>(waitForRpc(page, procedure), procedure);
void output.catch(() => undefined);   // handler at creation
await action();
return output;                        // ORIGINAL promise: still reports the refusal
```

The old `try/catch` is gone; its only job (swallow the armed read when the
action rejected) is now unconditional and earlier. `.catch` derives a new
promise, so `output` keeps its rejection and an awaited call still reports it.

## Proof, pre-fix vs post-fix

New `tests/e2e/rpc-helpers.spec.ts`, three tests:

| Test | Proves | Non-vacuity evidence |
|------|--------|----------------------|
| refused RPC mid-action → ACTION error, no unhandled rejection | the round-3 contract | **Fails against the pre-fix helper** (`git show HEAD~2:tests/e2e/rpc-helpers.ts`): `unhandled rejections: customersCreate failed with HTTP 500`. Passes post-fix. |
| refused RPC the action outlives → awaited call rejects | the handler did not swallow it | **Fails against a mutant** `return output.catch(() => undefined) as Promise<T>` (`.rejects.toThrow` on a resolved promise). |
| action throws before any RPC → action error surfaces | the removed `catch` path is still covered | passes post-fix; the armed wait is left pending and its later teardown rejection is handled. |

The first test routes `customersCreate` to a 500, has the action `await` the
refusal and stay in flight one turn, then throw `ACTION_FAILED`. The process
`unhandledRejection` list is asserted free of the armed read's rejection, scoped
to the procedure name because `workers: 1` shares one process across spec files
(an unrelated late rejection must not fail this test for the wrong reason). Test
2 pins the `customersCreate failed with HTTP 500` text the filter matches on, so
the filter cannot silently go vacuous. Each fixture asserts `refused() === 1`, so
a URL that stops matching fails loudly instead of writing a throwaway customer
into the shared database.

## The second early-promise walk (brief requirement)

Every promise in the helper, and whether it can be observed handler-less:

| Promise | Where created | Handler | Verdict |
|---------|---------------|---------|---------|
| `page.waitForResponse(...)` | `waitForRpc` | `.then` attached **synchronously** by `readEnvelope` in the same expression/`tick` | safe |
| `readEnvelope(...)`'s `ack.then(...)` | `readEnvelope` | this was `output`; now handled at creation in `actAndAck` | **fixed** |
| `page.evaluate(...)` | `readRpc` | awaited in the same statement; inner `fetch`/`json()` are sequential awaits | safe |
| `action()` | caller | `await action()` immediately | safe |
| `void output.catch(...)`'s derived promise | `actAndAck` | callback returns `undefined`, cannot reject | not a gap |

There is exactly one handler-less promise (`output`). The "second" late-handler
site was the old `void output.catch(...)` inside the action's `catch` — the same
promise, attached after the rejection had already fired. The fix attaches one
handler at creation and removes that site.

## Review findings and disposition

Three read-only agents ran on `b5515da` (test-audit, code-review
Standards/Spec), then a critic/defender debate; the parent applied the findings
and re-verified at `0279269`.

| Source | Finding | Disposition |
|--------|---------|-------------|
| test-audit | opaque `toEqual([])` failure | fixed — full list in the message |
| test-audit | route mock could stop matching silently | fixed — `refused() === 1` |
| test-audit | action-throws-before-RPC uncovered | fixed — third test |
| critic 🟠 | process-global listener can trip on another spec's late rejection | fixed — assertion scoped to the procedure name |
| critic 🟡 | `SETTLE_MS` comment said "one event-loop turn" | fixed — "comfortably past the reporting turn" |
| standards | duplicated fixture setup across tests | fixed — `refuseCustomersCreate` helper |
| standards | rationale restated in helper + spec | trimmed the spec header to point at the helper |
| standards | timing-based assertion | kept; the observation is inherently a timing signal and 50 ms is ~3 orders of magnitude past Node's reporting turn |
| defender | no other handler-less promise; removing `try/catch` is a strict superset | confirmed; recorded in wisdom |
| test-audit/critic | `waitForRpc` timeout and page-close mid-action are not pinned | accepted — covered by the no-op handler, a 30 s timeout is not worth an e2e test |

## Gates (commands and exit codes)

```
bun run typecheck                                            exit 0 (3/3 turbo)
bun run lint                                                 exit 0
bun run test                                                 exit 0 (977 web pass / 0 fail)
bunx playwright test tests/e2e/rpc-helpers.spec.ts           exit 0 (3 passed)
  isolated ports: DOKAN_PORT=4477 DOKAN_WEB_PORT=5321
                  DOKAN_VAULT_PORT=4433 DOKAN_VAULT_WEB_PORT=5322
bun run test:e2e (same four ports)                           exit 0 (61 passed, 8.5m)
```

One sibling lane (`test-206-vault-port-coverage`) was live throughout. No spec
flaked in either full run; unlike round 2 there was no vault contention flake to
rerun.

## Residual coverage gaps (non-blocking)

- `readRpc`'s non-2xx / malformed-envelope throws and its vault-header branch are
  still exercised only indirectly (carried from round 2).
- `waitForRpc`'s 30 s timeout path has no focused test.
- The refusal fixture is a synthetic 500; it pins helper behaviour, not that the
  server refuses.
