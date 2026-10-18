# #183 code-review evidence (PR #203 review-fix round 3)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Reviewed head (code): `cd28eef8c005d43a32c906add7068c9b4d60f6e6`
- Diff reviewed: `git show cd28eef` (the round-3 fix on top of the previously
  reviewed head `6769195`)
- Axes: Standards and Spec, reviewed independently by a reviewer sub-agent over
  the commit, then synthesized here.

## Standards

Sources: `AGENTS.md` (search scope), the repo's oxlint config (clean),
surrounding page conventions.

- `liveListFailure()` (`supplier-opening-balance.tsx:130-137`) is small,
  single-purpose, and reads through the page's existing `queryClient`. Its doc
  block states why the cache is authoritative (status flips before React
  commits) and documents the `{ message: undefined }` case that
  `state.error?.message` produces. Accurate.
- `listFailed` is not left dead: still the synchronous `submit()` entry guard
  (`:408`) and the two disabled controls (`:681`, `:704`), with `listError` for
  the banner (`:547`). The "render gate" vs "write-time gate" split is a real
  distinction.
- The second live check in `submit()` (`:432`) is not redundant with `save()`
  (`:312`): `submit()` can open the confirmation dialog (`:441-444`) without
  ever calling `save()`, so without `:432` the dialog would be named from counts
  the failed read no longer backs. The third regression test pins that.
- Tests follow file conventions (`WAITING_READ_FAILURES` mirrors the existing
  `NEW_TAB_ACTIVATIONS` table; comments carry the why). Lint clean.

Worst items — nits, not changes:
- `:131` re-lists the two gated query keys; `supplierReadQueryKeys` (`:107`)
  also carries `suppliersList`, which this page must not gate on, so it cannot
  be reused as-is. A shared `gatedReadKeys` constant would remove the literal.
- `liveListFailure()` returns `{ message }` but is only truthiness-tested.
  Acceptable — it must carry the message.
- `expect(clickTarget("opening-balance-error")).not.toBeNull()` is tautological
  because `clickTarget` throws, but matches existing usage at `:292`/`:298`.

## Spec

Spec source: the Greptile round-3 finding (a read failing during the resolver
await must not write and must not be excludable by a captured boolean).

Correct:

- The finding is closed: `save()` consults the live cache at write time (`:312`)
  immediately before `bulk.mutateAsync`; `submit()` re-checks after the resolve
  await (`:432`) before naming the dialog. No captured `listFailed` reaches a
  write.
- `bulk.mutateAsync` exists only in `save()`; `submit()`'s `listFailed` (`:408`)
  is read synchronously in the event handler with the live check as backstop.
- The regression tests fail the read **after** `submit()` starts: they park
  `resolveHold`, click save, assert `resolveCalls === 1`, then set the flag and
  invalidate, assert the banner, then release. Independently reproduced by the
  reviewer: the test file run against the parent source (`6769195`) fails all
  three cases; at HEAD it is green.

Residual (out of scope, documented):

- The refusal-recovery branch (`save()` catch, `:369-380`) re-resolves after
  invalidating reads and can re-open the dialog off a snapshot that outlived a
  later read failure. Its write is still blocked by the `save()` live check, so
  no write escapes; only a transient dialog-naming risk remains. Not part of
  this finding; candidate for a future round.

## Summary

Standards: pass, three non-blocking nits. Spec: finding closed, regression tests
proven to fail on the parent. No blockers.
