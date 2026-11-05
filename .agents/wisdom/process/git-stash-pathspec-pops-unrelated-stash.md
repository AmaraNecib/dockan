# A successful stash command may have saved nothing

Observed during a mutation check in the 2026-10-14 session.

`git stash push -- <path>` can exit successfully when the path has no changes.
An unconditional `git stash pop` then applies an unrelated older stash.

For a controlled mutation, preserve the exact original file and restore only that
path after the check. Verify the restored diff. If using stash, compare its
object ID before and after creation; apply only the newly created stash after
confirming its contents. A message or `stash@{0}` alone is not stable identity.

A conflicted pop retains its stash. Preserve current staged and unstaged changes
before recovery. Resolve affected paths individually; whole-tree reset can
destroy unrelated work and requires the destructive-action approval process.
