# #179 — Test audit evidence (3 agents)

- **Reviewed HEAD:** `aa2cbe8d553267025d986e749805a1a3c8d4cafc`
- **Base:** `8bf2a817a2d25a58653704f1c4c15542bd822cc2`
- **Method:** three parallel read-only sub-agents (EDGE CASE HUNTER, COVERAGE
  ANALYST, TEST QUALITY REVIEWER), run at `2faa306` and repeated at `aa2cbe8`.

## Findings and decisions

| Agent | Finding | Risk | Decision |
|---|---|---|---|
| Edge case | `expectRpcOk` non-2xx branch (`rpc-helpers.ts:26-28`) never executed; the "fails loudly on a refused write" mitigation is unverified. | 🔴 | **Deferred** (see below). |
| Edge case | `waitForRpc` matches any POST to the path; a duplicate/retry `catalogSearch` could satisfy the wait. | 🟠 | **Dismissed** — sequential fills, all writes acked; the ack bounds the wait, the row assertion is the truth signal. |
| Edge case | Negative `toHaveCount(0)` can pass on a transient render before the new query lands. | 🟠 | **Dismissed** — each positive `toBeVisible()` precedes the negatives, and the `batteryItem`-absence check *is* the freshness proof (it was visible for the previous query). |
| Edge case | limit-20 truncation could evict the stamped row. | 🟠 | **Accepted** — documented design risk; no category filter exists in the contract; app change out of scope. |
| Edge case | Parties search is client-side over a server-capped page. | 🟠 | **Accepted** — page size is 500 (`openListsWide`), the run is bounded by the per-run wipe, and it is pre-existing behaviour, not introduced here. |
| Edge case | `rpcOutput` has no shape guard. | 🟡 | **Dismissed** — the oRPC envelope is contract-guaranteed; a missing `json` fails loudly at `toMatch`. |
| Coverage | (a) stable spec-scoped signal — covered; (b) cross-spec dependence — partial (scoped rows, truncation residual); (c) race verdict — stated test-side; (d) repetition evidence — initially missing. | — | (d) **provided** under `aa2cbe8-*` logs (3× full suite green, affected specs `--workers=2` green). |
| Coverage | No durable regression that reproduces the old failure mode (the experiment specs were throwaway). | 🟠 | **Accepted** — the experiment is logged in `179-latency-experiment.log` / `179-read-latency-experiment.log`; committing a permanently-red-on-purpose spec is not viable. |
| Quality | Helper API, names, async handling, isolation all sound; `SAFETY:`/JSDoc conventions followed. | — | **Grade A−** at `aa2cbe8`. |
| Quality | `waitForRpc`/`expectRpcOk` exported but used only inside the module. | 🟡 | **Accepted** — documented helper API in the design. |
| Quality | `parties-notice` assertion is redundant after the ack. | 🟡 | **Kept** — it still asserts the UI success notice renders. |

## Deferred items

1. **Helper failure-path test.** Add a focused test that drives `actAndAck` /
   `expectRpcOk` against a refused RPC (e.g. a routed 500) and asserts the
   rejection carries the status. Deferred because it needs a new spec file,
   which would expand the reviewed surface beyond the brief's "keep edits to the
   flaky specs and shared helpers" scope and force the whole acceptance
   baseline to be re-run. The branch is a single `expect(ok())` and is exercised
   by any real refusal in the suite.
2. **Same-class unwrapped UI polls** on non-reported writes (`settings-save`,
   category create, quick-add item, `pmt-submit`). Out of the reported failure
   set; a follow-up could convert them to the same ack helper.

## Verdict

Coverage of the two reported failures is direct and proven. The remaining items
are either accepted design risks or explicitly deferred with rationale; none is
a blocker for this test-only fix.
