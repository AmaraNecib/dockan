# Debate evidence — issue #129 (round 3 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `2db1b35a01f3919a06eb5c57109ee8c7a6eab0d1`.
**Code under review:** `b5515da` + `0279269`; `2db1b35` adds only the wisdom
entry. A critic and a defender each reviewed the fix and the new
`tests/e2e/rpc-helpers.spec.ts` read-only; the parent synthesised and applied the
findings below.

## Critic

| # | Finding | Severity |
|---|---------|----------|
| C1 | The `unhandledRejection` assertion is process-global (`workers: 1` shares one process across spec files), so a late rejection leaking from an earlier file could fail this test for the wrong reason; the assertion also never checked the message. | 🟠 |
| C2 | The 50 ms sleeps are over-timing, not under-timing; `SETTLE_MS`'s "one event-loop turn" comment did not match the constant. | 🟡 |
| C3 | The commit rationale slightly overstated the old gap: the pre-fix `catch` already covered sync/async action throws and page close; only the *during-action* window was open. The new handler is a strict superset. | 🟡 |
| C4 | The "action error wins" assertion is near-tautological because the action awaits its own refusal; the valuable race is test 2's refused-but-outlived case. | 🟡 |
| C5 | The route mock is non-vacuous (`refused() === 1`) but pins helper behaviour, not a real server refusal. | 🟡 |
| C6 | No promise is left without a handler; the only derived promise (`void output.catch(...)`) cannot reject. | note |

## Defender

- The fix is minimal and correct: one handler moved ahead of `await action()`,
  old `try/catch` deleted; `output` keeps its rejection, so awaited callers still
  see refusals. `bunx playwright test tests/e2e/rpc-helpers.spec.ts` → 3 passed.
- Test 1 discriminates: pre-fix `output` has no handler until the action rejects,
  so Node reports the refusal unhandled ~50 ms before the old `catch` could
  attach. `refused() === 1` makes the fixture self-verifying.
- Test 2 guards the swallow mutant (`.rejects.toThrow` on a resolved promise).
- No regression from removing `try/catch`: test 3 passes; the dangling armed wait
  is routed into the handled chain and rejects later on page close, already
  handled.
- No other promise in the helper is created before its handler.
- Critiques it could not honestly rebut: `SETTLE_MS` is a wall-clock heuristic,
  and the global `unhandled` list can be tripped by an unrelated late rejection
  (flakiness, not correctness); it did not re-run the pre-fix helper.

## Resolution

| Finding | Resolution |
|---------|------------|
| C1 | **Fixed** at `0279269`: the assertion is scoped to rejections whose message names the procedure under test; the full list is still reported on failure; test 2 pins the message text the filter matches on. |
| C2 | **Fixed**: comment corrected to "comfortably past the reporting turn". The 50 ms value is retained — the observation is inherently a timing signal and 50 ms is far past Node's reporting turn. |
| C3 | **Accepted as wording**: the test-audit and code-review evidence state the superset relationship correctly, and test 3 pins the path. |
| C4 | **Accepted**: test 1's positive assertion is a sanity check; its discriminating assertion is the scoped `unhandled` list, and the pre-fix run proves it fails there. |
| C5 | **Accepted and documented**: the fixture pins helper behaviour; the server's own refusal is covered elsewhere in the suite. |
| C6 | **Accepted**: recorded in the wisdom entry. |

No blocker. The debate changed no behaviour beyond `0279269`'s assertion scoping.
