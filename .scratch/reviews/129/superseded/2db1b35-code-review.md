# Code-review evidence — issue #129 (round 3 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `2db1b35a01f3919a06eb5c57109ee8c7a6eab0d1`.
**Round-3 commits:** `b5515da`, `0279269`, `2db1b35`.
**Code under review is unchanged from `0279269`; `2db1b35` adds only the wisdom
entry. Product code unchanged since `0631081`; the round-3 delta is
`tests/e2e` + `.agents/wisdom` only.**

Two read-only review agents (Standards, Spec) ran on `b5515da`; the parent
applied their findings at `0279269`. No open blocker.

## Standards

Documented standards: `docs/engineering-workflow.md`,
`docs/development-workflow.md` (Definition of Done), `AGENTS.md`,
`oxlint.config.ts`, `.agents/skills/guard/SKILL.md`,
`.agents/skills/writing-for-agents/SKILL.md`.

**Verdict: PASS.**

- **The fix keeps the contract.** `tests/e2e/rpc-helpers.ts:60-69`: the handler is
  attached at creation and the original `output` is returned, so
  `actAndAck`'s documented "returns the server-acknowledged output" is intact.
  `.catch` derives a new promise; it does not consume the rejection.
- **The removed `try/catch` loses no path.** Its only behaviour was swallowing
  the armed read once the action rejected; the unconditional early handler is a
  strict superset, and the third spec test pins the action-throws-before-RPC
  path that motivated the old comment.
- **Anti-slop rules satisfied without evasion.** The spec passed `oxlint` with
  the two new helpers. Notable: `no-known-value-widening` rejected an explicit
  anonymous return type on `trackUnhandledRejections` (inference kept);
  `no-unknown-parameters` rejected `reason: unknown` (the listener takes
  `Error | string` and normalises); `require-safety-comment-for-type-assertion`
  drove the `instanceof Error` narrowing instead of a cast.
- **Reviewable-path rule honoured.** `tests/` is not in the guard's enumerated
  reviewable list, but this round treats a `tests/` delta as evidence-invalidating
  (conservative reading, as in round 2), so the evidence set exists at the new
  SHA.
- **No product files touched.** `git diff 0949177..2db1b35 -- apps packages` is
  empty.

Nits (non-blocking):
- `waitForRpc` remains exported but externally unused; demoting it would make
  `actAndAck`/`readRpc` the only public surface (carried from round 2).
- `readCustomers` + `CustomerListPayload` are still duplicated across
  `phone-identity.spec.ts` and `customer-name-variants.spec.ts`; a
  `parties-helpers.ts` would remove the drift (carried).
- The route-mock regex is anchored at the end only; a future query string would
  stop it matching. The `refused() === 1` assertion makes that fail rather than
  silently pollute the shared database.

## Spec

Round-3 requirement, clause by clause:

| Requirement | Verdict |
|-------------|---------|
| Attach the handler immediately: `const output = readEnvelope(waitForRpc(page, procedure), procedure); void output.catch(() => undefined);` | Met — `rpc-helpers.ts:60-67`. |
| Keep the original promise so `actAndAck` still reports the RPC failure when awaited | Met — `return output` untouched (`:69`); proven by spec test 2 and by a mutant run. |
| Prove it by forcing a refusal while the action is in flight, showing the ACTION error is reported with no unhandled-rejection warning | Met — spec test 1; pre-fix helper fails it with `unhandled rejections: customersCreate failed with HTTP 500`. |
| Walk the helper for any other promise created before its handler (the arm, `readEnvelope`, `waitForRpc`, `readRpc`) and report | Met — test-audit evidence has the table; `output` was the only gap. |
| No production behaviour change | Met — `tests/e2e` + `.agents/wisdom` only. |

No scope creep: one helper hunk plus the regression spec and the wisdom note.

## Gates

```
bun run typecheck                                            exit 0
bun run lint                                                 exit 0
bun run test                                                 exit 0 (977 web pass / 0 fail)
bunx playwright test tests/e2e/rpc-helpers.spec.ts           exit 0 (3 passed)
bun run test:e2e (DOKAN_PORT=4477 DOKAN_WEB_PORT=5321
                  DOKAN_VAULT_PORT=4433 DOKAN_VAULT_WEB_PORT=5322)   exit 0 (61 passed)
```

One sibling lane live; no flake in the full run.
