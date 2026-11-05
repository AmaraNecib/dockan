# Recover partial work without overlapping writers

Seen in: #275 and an earlier provider-handoff context failure.

A failed agent can leave useful uncommitted files. Inspect the existing checkout,
diff and local evidence before restarting. A fresh checkout from the last commit
does not contain those edits.

A long conversation, quiet logs or multiple review rounds do not make a running
agent terminal. Confirm its actual task state. Before replacement, stop the old
writer through supported orchestration controls and confirm cancellation.
Transfer exclusive write ownership of the existing PR worktree, with the goal,
remaining findings, exact base/head and dirty paths in the handoff.

Use the current session's supported checkout-binding and delegation controls.
Creating a new top-level conversation requires the owner's request. Preserve
partial work and evidence until the replacement has accepted the handoff.
