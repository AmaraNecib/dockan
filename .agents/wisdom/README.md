# Task-scoped lessons

Read this index, search for the task's symbols or failure mode, then read only
matching lessons:

```bash
rg -n "<symbol or failure mode>" .agents/wisdom
```

These files record past failures, not additional workflow gates. Current owner
instructions, `AGENTS.md`, the engineering workflow and the relevant skill govern
the work. Check a lesson's assumptions against the current source before applying
it. A past failure or success does not establish the cause of today's result.

## Keep the collection small

Only the parent writes lessons. Add one only after the same failure recurs, with
issue or PR references and a concrete prevention step. Workers put candidates in
their commit body under `Lesson:`, alongside relevant lessons applied or excluded.

Use `<category>/<lesson>.md`, without dates in filenames. Update the existing
lesson when it recurs. Keep the failure, its boundary and the prevention step;
remove obsolete commands, fixed model choices, historical counts and duplicate
policy. Retired text remains recoverable from Git history.

Review requirements belong in `docs/engineering-workflow.md` and `reviewloop`.
Verification commands belong in `guard`. Wisdom neither waives those requirements
nor adds a second review or verification cycle.
