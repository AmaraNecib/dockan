# #183 test-audit evidence (PR #203 review-fix round 3) — the key review

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Reviewed head (code): `cd28eef8c005d43a32c906add7068c9b4d60f6e6`
- Delta audited: `git diff 6769195 cd28eef -- apps/web/src/pages/supplier-opening-balance.tsx apps/web/src/pages/supplier-opening-balance.test.tsx`
- Shape: 3 parallel audit agents (edge case hunter, coverage analyst, test
  quality reviewer), then mutation proofs. Verdict: the new tests bite the
  named defect; a few gaps were fixed, the rest are documented below.

## What the finding was, and what the tests must prove

`save()` captured `listFailed` from the render that started `submit()`. If a
supplier read failed while `submit()` awaited `suppliersResolveName`, the
continuation still called the OLD `save()` with `listFailed === false` and wrote
the batch — for a new supplier or one with no entries — behind the failure
banner the page was already showing.

The tests therefore must fail the read **after** `submit()` is parked in its
resolve await, then release the resolver. A read failed before `submit()`
starts would pass against the bug (the starting render already carries
`listFailed === true`).

## New tests

`WAITING_READ_FAILURES` parameterizes both gated reads
(`suppliersListNames`, `suppliersAccountSummaries`). Each case:

1. parks the resolver (`resolveHold`) before `render()`;
2. starts `submit()` on a typed new supplier (resolver answers `null`, no cached
   entries: the direct-save path the finding names) and asserts
   `resolveCalls === 1`;
3. **fails the read while the resolver is still held** (`fail()` +
   `invalidateQueries`), asserts the failure banner is committed;
4. releases the resolver and flushes;
5. asserts `captured === null`, `mutationCalls === 0`, no saved banner;
6. recovers (`recover()` + invalidate), re-submits and asserts
   `mutationCalls === 1` — proving the released continuation resumed and the
   gate does not latch the owner out.

A third case, `does not open the confirmation off a read that failed while the
name lookup was held`, parks a typed name that resolves to an entry-bearing
supplier, fails the account summary during the hold, releases, and asserts the
confirmation dialog did **not** open and nothing was written. This pins the
submit-continuation guard (below), not just `save()`.

## Mutation proof that the tests bite the defect

Stashed only the source file (revert to the pre-fix HEAD), ran the three new
tests (filter `Greptile round 3`):

```
(fail) does not write when the names read fails while the name lookup is held
(fail) does not write when the account summary read fails while the name lookup is held
(fail) does not open the confirmation off a read that failed while the name lookup was held
  1 pass    (an older, unrelated "refreshes suppliers after a confirmed refusal" test)
  3 fail
```

Removing just the post-await submit guard (keeping the `save()` live check) and
rerunning the dialog test also fails it (`vault-settings-saved`-style
`confirm` not null at the assertion), so each new mechanism is independently
pinned. Source restored and re-verified after each mutation.

## Would the tests still pass if the gate were stale?

Against the **captured boolean** (the actual defect): no — all three fail, as
above. Against a **fresher mirrored boolean/ref**: yes, they would pass, because
the test commits the failure render (`await settle()`) before releasing the
resolver, so any render-mirrored value is already `true` at write time. This is
an accepted, documented limitation of the test shape the brief mandated: the
suite pins the observable requirement (no write after a during-await read
failure), and the implementation is the stronger live-cache read, so it cannot
be satisfied by a lagging mirror. A commit-free cache-flip test would
distinguish them but depends on query-core internals and would be brittle;
deferred. The old "fails before submit" tests (lines ~1173/1198) remain
non-discriminating for this class, so no duplicate coverage.

## Class audit — every value a pending continuation reads

| Value | Read by | Stale by use? | Action |
|---|---|---|---|
| `listFailed` / `listError` (render) | `submit` entry, `save` gate, buttons | **YES** — the finding | Fixed: `liveListFailure()` reads the query cache at use time in `save()`; `submit()` re-checks live after the resolve await |
| `attemptRef.current` | submit after await, `resolveForSubmit`, refusal recovery | No — ref, bumped synchronously by every batch edit / dismissal | none |
| `dismissalRef.current` | refusal recovery | No — ref, bumped by `abandonAttempt` | none |
| `mountedRef.current` | every post-await `setState` | No — ref, set/cleared in a layout effect | none |
| `resolveKeyRef.current` | refusal recovery | No — kept current in a `useLayoutEffect` at commit; a lookup-field edit also bumps `attemptRef` synchronously | none |
| `resolving` (state) vs `resolvingRef` (ref) | guards use the ref; state is render-only | No | none |
| `submitting` / `bulk.isPending` | `submit` entry only (fresh render) | No — discrete click events flush between clicks; not read by a continuation | none |
| `destination.accountEntryCount`, `existingNeedsConfirm` (read-derived) | `submit` after await | **YES** before the fix — could open the dialog off counts from a failed read | Fixed: post-await `liveListFailure()` stop, test added |
| `occurredAt`, `reasonDraft`, `drafts`/`filledExisting`, `newName`, `newDirection`, `typedAmount`, `typedRowReady` (captured in `save`) | `save` | No — every input calls `invalidateAttempt()` and `submit` checks `attempt === attemptRef.current` before `save` | none |
| only `status === "error"` but `error === null` | `liveListFailure` | Latent hole: an early `return state.error` would return `null` and skip the second key | Fixed: returns `{ message: error?.message }`, so an error status always blocks |
| resolve-read (`suppliersResolveName`) state | — | Correctly excluded; a resolve failure must not block retries | none |

## Audit findings disposition

- **Fixed** — submit continuation could open the confirmation off a failed read
  (edge hunter #1; guard + third test).
- **Fixed** — `liveListFailure` `status:"error"`/`error:null` early-return hole
  (edge hunter #6).
- **Fixed** — purely negative assertions / no resume proof (quality reviewer
  note 1): added the recovery write assertion.
- **Deferred, documented** — commit-free cache-flip test to distinguish live
  cache from a mirrored ref (coverage #5); StrictMode render variant (edge
  hunter #3, no StrictMode harness in this file); a failure arriving after the
  live check begins the mutation is a point-in-time snapshot with no await in
  between (edge hunter #4).
- **Rejected** — asserting the specific read message: `tError` maps both
  synthetic mock messages to the same generic Arabic string, so the
  parameterized `queryKey` is the meaningful discriminator.

## Not re-audited

The prior rounds' mutation proofs (blockedReason sweep, requestSubmit sweep) are
on tests this delta did not change and were not re-run.
