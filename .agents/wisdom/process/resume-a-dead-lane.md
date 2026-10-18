# Resuming a lane that died mid-work: re-enter the worktree, never start a fresh one

**Date:** 2026-10-18 · **Ticket:** 275 · **Area:** orchestration — delegated lanes, `t3_thread_launch`, `t3_thread_send`

A lane ran 35 minutes on a review-fix batch, then died. It left real work behind: 7 modified files
(+262/-62) and a new module `boot-loss.ts` with its test, written minutes before the death.

Two ways to recover, and the wrong one costs the work:

1. **Right:** `t3_thread_launch` with `workspaceStrategy: {type: "existing_worktree", worktreePath,
   branch}`. Same worktree, same branch, partial edits intact, fresh conversation. The lane's prior
   context is *not* needed — the findings are on disk in `.scratch/reviews/<issue>/<sha>-<lens>.md`,
   which is exactly what the review pipeline writes them for.
2. **Wrong:** `delegate_task` with `isolation: "worktree"`. That creates a *new* worktree from the
   parent's local commit. The partial edits stay behind in the dead lane's worktree, and the branch
   cannot be checked out there because another worktree holds it.

**The trap that produced the death:** sending two batches into a lane whose conversation was already
large (314 items). The first batch started a run, the second was steered into it, and the run died
mid-work. A lane that large is a compaction hazard — the same "Insufficient context allowance for the
provider handoff" failure seen in an earlier session.

**The rule:** after a lane has been through more than one review round, treat it as terminal even
while it is running. Put the next batch in a **fresh** lane rather than steering more into the live
one. Point the fresh lane at the evidence files, which are self-contained.

**Corollary:** evidence files are the handoff format, not the conversation. `.scratch/reviews/<issue>/`
already holds one file per lens per head — a fresh lane reads them in full and needs nothing else.
Keep a copy outside the lane worktree as well; the worktree is disposable, the findings are not.

**Detection that worked:** `t3_thread_read` with `runLimit` shows each run's status and timestamps. A
`failed` run that lasted 35 minutes is a lane that was *working*, not one that never started — check
`git status` in its worktree before assuming nothing happened.
