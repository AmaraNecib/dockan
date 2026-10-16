# Test-quality audit — issue #129 (PR #209)

**Worktree:** `D:/projects/mani-worktrees/fix-129-numeric-phone`
**Branch/HEAD:** `fix-129-numeric-phone` @ `ee32c44fda6dff90309535dbcabbbf412ade2609`
**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (merge-base with origin/develop)
**Scope:** whole reviewable diff (`apps packages tests`) at HEAD, with the one delta since the
already-reviewed `da727f9` verified in depth.
**Prior audit:** `.scratch/reviews/129/da727f9-test-audit.md` (grade B). Not re-litigated.

## The delta under review

`git show ee32c44` — a single 4-line addition to `tests/e2e/rpc-helpers.spec.ts` test 1.

`tests/e2e/rpc-helpers.spec.ts:74-77` (added immediately after arming `refusal` at `:73`):

```ts
const refusal = page.waitForResponse(rpcUrl);   // :73
// handle the abandoned wait at creation too (see the next test): a fill
// or click that throws before `await refusal` must not surface the
// wait's own rejection on top of the action's error
void refusal.catch(() => undefined);            // :77
```

**Verified correct, no defect.**
- `refusal` is still the *original* promise; `.catch()` returns a derived promise, so the later
  `await refusal` (`:84`) still rejects on the original path. Semantics unchanged.
- In the happy path the route fulfills 500, so `waitForResponse` **resolves** (it resolves on any
  response regardless of status); the handler is dead code and cannot swallow the assertion the test
  is built on.
- The test's discriminating power is preserved: it relies on `actAndAck`'s own
  `void output.catch(...)` (`tests/e2e/rpc-helpers.ts:49`). Pre-fix the unhandled message is
  `customersCreate failed with HTTP 500`, which the `:87` filter (`includes("customersCreate")`)
  still catches. The added spec-local handler only guards the *spec's* abandoned wait, whose timeout
  message does not contain `customersCreate`, so it does not pollute the filter.
- The change genuinely closes a real edge: if `fill`/`click` (`:78-80`) throw before `await refusal`,
  the abandoned wait's rejection no longer masks the action error. This matches test 2's pattern and
  the commit rationale (Greptile P2). Net effect: **positive** (robustness + consistency), grade-neutral.

The delta changes none of the settled decisions (readRpc/envelope-gap deferrals, SETTLE_MS heuristic,
worker-wide listener). It neither weakens nor duplicates coverage.

## Rest-of-diff quality (whole diff at HEAD)

### Strengths (evidence)

| Dimension | Evidence |
|---|---|
| Names | Behavioural + issue tag, e.g. `rpc-helpers.spec.ts:61` "actAndAck reports the action error, not a refused RPC…"; `phone-identity.spec.ts:78`; `party-phone.test.ts:16`. Each names the rule, not the implementation. |
| Assertion quality | The route mock is self-verifying: `refused()` count asserted (`spec.ts:53-66`, `:88`). Exact message pins (`rejects.toThrow("customersCreate failed with HTTP 500")`, `:152`). Diagnostic failure text `unhandled rejections: ${unhandled.join(" | ")}` (`:91`). Server-payload assertions instead of DOM where the DOM can lie (`phone-identity.spec.ts:46-56`). |
| Isolation / cleanup | `stop()` + `page.unroute()` in `finally` (`spec.ts:93-96`, `:131-134`); `phone-identity.spec.ts:59-74` `afterEach` re-reads the server list and asserts the created names are gone. |
| Async handling | `actAndAck` arm-then-act; test 2 uses a 100ms wait timeout so the abandoned rejection fires in-test (`:111`); the helper attaches its handler at creation (`rpc-helpers.ts:45-50`). |
| Table/decision pinning | `party-phone.test.ts` table-driven accept/reject plus the Arabic-Indic identity pin (`:33-38`), bidi marks (`:75-81`), non-folded scripts (`:87-91`), legacy-permissive read key (`:94-99`). |
| Readability | Dense but purposeful rationale comments; each non-obvious assertion explains the failure class it guards. |

### Weaknesses / observations (mostly carried, none blocker)

- **Setup duplication (minor):** tests 1 & 2 (`spec.ts:61-102`, `:104-136`) repeat the identical
  `openNewCustomerForm` → `refuseCustomersCreate` → `trackUnhandledRejections` → `let thrown; try/catch`
  skeleton. A small `runRefusedAction(thrower)` helper would remove ~15 duplicated lines. Cosmetic; the
  duplication also keeps each test's abort path explicit, so I do **not** recommend churn. 🟡
- **Duplicated `readCustomers`:** byte-identical helper in `phone-identity.spec.ts:46-56` and
  `customer-name-variants.spec.ts` (`git diff` shows the near-identical body). Pre-existing shape,
  carried/deferred. 🟡
- **Timing heuristics:** `SETTLE_MS = 50` (`spec.ts:20`), 100ms wait timeout (`:111`), 300ms sleep
  (`:124`). Documented, not derived from one constant; retained from prior rounds. Under CI load the
  pre-fix signal could in principle report after the sleep, but 50 ms is far past Node's reporting turn.
  🟡
- **Worker-wide `unhandledRejection` listener:** `spec.ts:24-31` observes the whole process; a late
  rejection from another spec containing `customersCreate` could fail test 1 for the wrong reason. The
  `:83-90` comment acknowledges this and the `:87` filter is the mitigation. Carried. 🟡
- **Test 1 comment over-claims nothing now:** after the delta, the "abandoned wait" rationale is
  accurate — the added handler is exactly what the comment says. 🟢
- **Test 2 pins the spec's own handler pattern, not `actAndAck`** (`:104-136`): deliberate (the
  `04b21e5` regression), value documented; fails if the creation-time `void refusal.catch` is removed. 🟡
- Coverage gaps carried from prior audit (readRpc focused test, `rpcOutput` throw branch, supplier-role
  UI parity, API-sourced `INVALID_PARTY_PHONE` rendering) are unchanged by this delta. Not re-graded.

## Grade: **B**

Discriminating, self-verifying, well-isolated where it matters (exact mock counts, `finally` cleanup,
server-payload assertions, decision-pinning tables). Held below A by the carried items above: magic
timing sleeps, a worker-wide rejection listener, duplicated list-read/abort boilerplate, and the
outstanding `readRpc`/envelope-guard coverage gaps. The reviewed delta is correct and slightly improves
robustness and consistency; it does not move the grade.

## Delta verdict

`ee32c44` (`rpc-helpers.spec.ts:74-77`): **sound, minimal, correct, no regression, no test-quality
impact.** No fix requested.
