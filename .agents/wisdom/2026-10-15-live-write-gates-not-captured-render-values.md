# A write gate must read live state, never a captured render value (🔴)

**Date:** 2026-10-15 · **Ticket:** 204 (debate/test-audit found it) · **Area:** apps/web supplier-opening-balance

Fix #204 added `hasRemovedFilled` (a render value) as a fourth guard beside the
existing `blockedReason`/`listFailed` gates. But `submit()` awaits
`resolveForSubmit()` before calling `save()`, and `save()` can also resume from a
refusal-recovery continuation. A background refresh that removed a filled draft
during that await updated React state, yet the continuation's `save` closure still
read `hasRemovedFilled === false` and posted the removed supplier's row. The server
rejected the whole batch (`PARTY_NOT_FOUND`), so no money landed on a ghost account —
but the batch failed and the owner's other amounts were not saved.

The page already documents this exact class for `listFailed` (Greptile round 3):
*"'save'/'submit' can resume after the render that started them, so a captured
'listFailed' can be false while a read has since failed."* #204 reintroduced it.

**Always**: when a boolean gates a write and the write can run after an `await`,
back the gate with a `ref` synced in the same commit (`useLayoutEffect`) and read
the ref inside `save()` — the way `liveListFailure()` reads the query cache. Better
still, make the state change itself invalidate the in-flight attempt
(`invalidateAttempt()`) so the continuation bails before it reaches the gate; do
both for defence in depth. Add the regression test with the resolver held open,
because a synchronous test passes even against the bug.

Related trap from the same fix: reconciliation that deletes draft rows must run off
`data === undefined ? null : ids` and skip `null`, or a cache reset / not-yet-loaded
list reads as "every supplier vanished" and flags every draft as removed.
