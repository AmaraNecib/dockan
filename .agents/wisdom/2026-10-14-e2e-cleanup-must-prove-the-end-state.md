# An E2E cleanup must prove the end state, not the click (🟠 Major)

**Date:** 2026-10-14 · **Ticket:** 130 (PR #189 review-fix round 1) · **Area:** tests/e2e

Greptile found three 4/5 issues on the #130 picker spec, and **two of them were
the same disease**: the spec passed while proving nothing.

1. `afterEach` treated a visible page shell as a loaded list. `PartiesPage`
   renders `parties-page-customer` while `customersList` is still pending, and a
   DOM `row.count()` has **no auto-wait** — so a saved customer could read as
   absent and be skipped, leaving it in the shared database while the run went
   green.
2. The deletion check asserted the success notice («تم الحذف»), which
   `PartiesPage` keeps across dialogs: the second deletion could pass on the
   *first* deletion's notice, before its own write landed.

**Always**: take presence from the **acked RPC payload**, not from the DOM
(`rpcOutput(await actAndAck(page, "<listProcedure>", …))` — see
`tests/e2e/rpc-helpers.ts`), then let `toHaveCount(1)` give the render its
auto-wait. Never decide "the record is not there" from a bare `count()`.

**Always**: after a delete, await that write's own acknowledgement *and* assert
the row disappears (`toHaveCount(0)`); then, in the hook, re-read the list and
assert the record is **gone from the server**. The final read is what turns a
silent skip or a failed write into a test failure instead of shared-DB drift —
and it is the only assertion that survives a future refactor to optimistic
updates.

**Always**: when a review round fixes a bug, ask of the new test "would it fail
if the feature were still broken?" — and prove it, by running the spec against
the pre-fix source. On this round the E2E's original steps passed on the broken
build (they only ever proved the pre-#130 behaviour, "the warning appears"); the
discriminating step had to seed **both** phoneless spellings and type the exact
one. A regression test that has never been seen red is a guess.
