# Treat inherited code and test claims as unverified

Seen in: #113, #207, #227.

An inherited accessibility test selected an element by ID without checking its
role, so it passed against the defect it claimed to prevent. Another assertion
became stale after a legitimate error-code alias.

Read inherited diffs against the current base. Check acceptance assertions and
mutation claims at the actual test boundary; commit messages describe intent,
not execution evidence. Use the current TDD and review requirements rather than
assuming an old green report applies.

Preserve existing partial work and inspect registered checkout ownership before
recovery. Use the current one-writer worktree policy, not retired crew launcher
commands.
