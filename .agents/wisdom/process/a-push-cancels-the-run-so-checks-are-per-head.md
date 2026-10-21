# Wisdom — 2026-10-21 · A push cancels the run, so a check state is per head

`.github/workflows/ci.yml:41-43` sets `concurrency: group: workflow-ref,
cancel-in-progress: true`. The effect on a watched PR is easy to misread: every
push **cancels the in-flight run and starts a new one**, so the checks a
notification names belong to the head it names and to no other.

Seen four times in one session on #345 and #341:

- a wake reported "all 7 checks passed on `d8887de`" while the head was two
  commits newer — the green was real, about a tree nobody was looking at;
- a wake reported "checks failed on `801e4e4`" for a head already superseded,
  and the failure had already been fixed;
- `60f4da6e` shows `completed/cancelled` because `74b2064c` was pushed 2½
  minutes later — not a failure, and not "CI did not run";
- the PR's check list can briefly show only the non-Actions checks (Socket),
  because the new run's jobs have not registered yet.

## What to do with it

1. **Read the head, not the verdict.** Before acting on any check state, compare
   the SHA in the notification with `gh pr view <n> --json headRefOid`. A green
   or a red for an older head is information about history.
2. **Batch a fold into one push.** Seven checks including an 8-minute e2e cost
   real minutes, and every push throws the finished ones away. Three commits
   pushed in three minutes bought nothing the last one did not.
3. **Never merge on a verdict anchored to another head.** The checks being green
   for `X` says nothing about `Y`, and Greptile anchors its score to a commit
   rather than to the branch — it must be re-requested after a push.
4. **A cancelled run is not a signal.** Look at the run list
   (`gh run list --branch <b>`) before concluding the pipeline is broken: the
   distinguishing words are `cancelled` and `in_progress`, not `failure`.

## Seen in

- #345 (purchase navigation guard), 2026-10-21 — three stale check notifications
  in a row, one `cancelled`, one "it did not run" that was a second push.
- #341 (vault cookie), 2026-10-21 — a 5/5 verdict anchored one commit behind
  after a fold, needing a re-request to count.
