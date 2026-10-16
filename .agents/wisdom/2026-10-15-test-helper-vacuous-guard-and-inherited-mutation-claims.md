# A DOM-based "non-empty batch" guard in a submit helper cannot see a batch whose inputs unmounted (🟡 Minor)

**Date:** 2026-10-15 · **Ticket:** 207 · **Area:** apps/web/src/pages/supplier-opening-balance.test.tsx

Ticket 207 extracts `submitForm()` so a "nothing was sent" test cannot pass on
an empty batch. The obvious hardening is a runtime guard inside the helper:

```ts
const filled = host.querySelectorAll('[data-testid="opening-balance-amount"]')
  .some((input) => input.value.trim() !== "")
  || host.querySelector('[data-testid="opening-balance-new-amount"]').value.trim() !== "";
expect(filled).toBe(true);
```

That guard fails the two read-failure tests. When the names/accounts read fails,
the page renders an error banner **instead of the table** (`listError !== null`
branch), so every amount input is unmounted. `querySelector` returns `null` while
React state still holds the typed row and `submit()` would send it. The guard
therefore fails the very tests it was meant to protect, without protecting the
null-hatch `validRowAmount: null` callers at all.

**Always**: before adding a DOM-read invariant to a test helper, check every
caller's rendered state at the moment the helper runs. For a batch that can be
held in React state while its inputs are unmounted, keep the invariant in the
JSDoc plus a mutation-verified test, and list the runtime guard as deferred. A
guard that only passes on the happy path is worse than the comment it replaced.

# "Verified in this lane" over an inherited mutation table is an unrun gate (🟠 Major)

**Date:** 2026-10-15 · **Ticket:** 207 · **Area:** .scratch/implementation/*-design.md, .scratch/reviews/

Ticket 207's abandoned branch shipped a discrimination table with two rows
labelled "(inherited; re-run not repeated this lane)". A later edit reworded the
intro to claim all four were "re-run in this lane on this HEAD" — but the HEAD
had changed since the table was written, and no commands or exit codes existed
anywhere. Two independent reviewers flagged it as a hard violation of
`docs/engineering-workflow.md` ("an unstated gate is an unrun gate").

**Always**: a design doc may name a mutation as a plan, but provenance belongs in
the evidence file. Re-run inherited mutations on the current base and record the
exact command, the exit code and the observed failure in
`.scratch/reviews/<issue>/<sha>-test-audit.md`. If you genuinely did not re-run
one, keep the "(inherited)" label and say so. Cherry-picking an abandoned branch
is fine — but the review gates are not inherited with it.
