# Test audit — #193 + #202 at `30a0359`

**Method:** `test-audit` skill — Edge Case Hunter, Coverage Analyst and Test
Quality Reviewer run as independent read-only sub-agents over the changed test
files, in two full rounds plus a third test-quality pass (interrupted after the
two code-review axes completed; its ground was already covered by rounds 1-2).
Findings and disposition below.

## What was audited

- `apps/web/src/pages/supplier-opening-balance.test.tsx` — new `fillAmounts`
  helper, applied to the round-5 201-supplier test and the 200-row
  contract-limit test; `BATCH_LIMIT_TEST_TIMEOUT_MS`.
- `tests/e2e/vault.spec.ts` — `vaultPort` resolver and its use on every path.

## Round 1 — Edge Case Hunter

Returned empty output (agent produced no findings). Replaced by the round-2
hunter, which did.

## Round 1 — Coverage Analyst

> - (a) vault port resolution: satisfied by inspection; no dedicated automated
>   test (nothing asserts the defaults/override).
> - (b) two concurrent vault runs: manual evidence only (recorded in
>   `30a0359-evidence.md`).
> - (c) the 200-row cap: automated and passing; the typed name is counted and
>   the page blocks before send.
> - **Note:** the sibling "blocks a batch over the 200-row contract limit" test
>   still filled 200 rows with discrete events (~47.8 s) — the timeout risk
>   merely moved. *Fixed in `c8ee009`.*
> - Duplicate coverage between the two cap tests is partial, not redundant (one
>   covers the inline-new-supplier route, the other the name→existing-row route).

## Round 1 — Quality Reviewer

> - `fillAmounts` is legitimate: it runs the page's real handler and the two
>   asserts depend on all 200 rows registering, so a partial fill fails. Event
>   wiring stays covered by `setInput`/`typeIntoRow`.
> - `BATCH_LIMIT_TEST_TIMEOUT_MS` is deliberate and justified, not magic.
> - Vault `Number(env ?? default)` has no validation (`""`→0, `"abc"`→NaN).
>   *Fixed in `9309830`.*
> - Grade B+ overall.

## Round 2 — Edge Case Hunter

> - Both cap tests are mutation-sensitive: if the page stopped counting the typed
>   name, or blocked at the wrong threshold, both fail. (Verified: a lowered
>   threshold is the only blind spot, and the lower bound is owned by
>   `supplier-opening-draft.test.ts`.)
> - Distinct per-row values are preserved (`String(index + 1)` maps by DOM order;
>   each input's `onChange` closure carries its own `supplier.id`).
> - `nativeValueSetter` at module scope was a fragility (`HTMLInputElement`
>   dereference at import). *Fixed in `9309830`.*
> - Vault env parsing edge cases. *Fixed in `9309830`.*
> - No blockers.

## Round 2 — Coverage Analyst

> - (a) satisfied by inspection; (b) manual only; (c) automated and passing.
> - Committing a two-process concurrency test has low ROI (needs two full vault
>   suites; root has no Bun harness for `tests/`). Recommend keeping it as
>   documented manual evidence. *Accepted — see report.*

## Round 2 — Quality Reviewer

> - `fillAmounts` legitimate, not a weakening; event-wiring coverage preserved
>   (only 2 of 20 tests use the fast path).
> - Timeout constant deliberate.
> - Independently timed the batched test at ~1.3-1.5 s, confirming the comment.
> - Grade A (web test file), B+ (vault spec).

## Round 3 — Test Quality Reviewer

Interrupted before returning (the workflow's other two children had completed).
Round-2 quality findings were re-verified by the final Spec axis, which read the
shipped tests and confirmed: both cap tests batch correctly, `vaultPort`
validation is sound, and the defaults are unchanged.

## Disposition of every finding

| Finding | Disposition |
| --- | --- |
| Sibling 200-row test still discrete-event | Fixed (`c8ee009`) |
| Vault env validation missing | Fixed (`9309830`) |
| Module-scope `HTMLInputElement` deref | Fixed (`9309830`) |
| Native-setter extraction duplicated | Fixed (`9309830`) |
| "<1 s / 60×" comment optimistic | Fixed (`c8ee009`) |
| No committed concurrency test | Deferred (documented manual proof; low ROI) |
| Lower-bound of the cap owned elsewhere | Accepted — covered by `supplier-opening-draft.test.ts` |

**Verdict:** no unaddressed test-quality finding that would let either spec pass
with the feature broken.
