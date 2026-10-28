# Code-linked review findings

Publish anchored findings as native GitHub pull-request review comments, not just file links in a summary. Each comment belongs to the reviewed commit, file and changed line range. GitHub can show its diff context and later mark the thread Outdated; the parent can mark it Resolved after verifying the fix.

## Publish once per head

1. Confirm the PR is open and its head equals the renderer's pinned head. Keep the measured evidence comment at that head with the `<!-- crew-evidence -->` marker.
2. Inspect existing PR reviews before posting. Reuse the review already published for this reviewed head instead of duplicating its threads. After an ambiguous API timeout, read the server state before retrying.
3. Post `<head>-review.json` to `POST /repos/{owner}/{repo}/pulls/{number}/reviews`. The generated request has `commit_id`, `event: COMMENT`, the summary body, and the anchored `comments` array. Each comment contains path, RIGHT-side line and, for a multiline finding, start_line and start_side. This creates native threads without submitting an approval or requesting changes as the human author.
4. Read the posted review comments back. Verify their commit, path and range against the generated payload before copying their html_url into the corresponding finding's permalink. Re-render the summary with those thread links and update the existing review body. Keep the same commit anchor and reuse those threads.
5. If the head moved during publication, label that review as old-head evidence and run the review at the new head. Never relabel an earlier thread or report as a current-head review.

The renderer writes a request artifact; it does not contact GitHub or manage threads. Publication and lifecycle checks are parent-owned. Findings outside eligible changed lines stay in the outside-diff list with pinned source links. Keep a visible parent disposition for them; do not fabricate a changed-line position to obtain an inline thread.

## Outdated is not fixed

After a fix, inspect the original thread, its original commit and the new code. An Outdated marker only means GitHub no longer treats the comment as current diff context. It does not prove that the defect is gone. A thread can remain current even after a nearby fix.

For each finding, record one disposition in the thread: open, fixed, dismissed with a code-backed reason, or deferred with an issue link. For a verified fix, reply with the fixing commit and the regression proof, then resolve the thread. Resolve a dismissed finding only after explaining why it is not actionable. Keep unresolved or deferred defects visible and apply the normal merge rules. Do not auto-resolve merely because a line moved, a force-push occurred or CI passed.

Before merging, read the current head's review threads, confirm that no actionable finding remains, and verify both reviewers' current-head verdicts. Native thread state complements commit-pinned evidence and the scored checks; it does not replace them.
