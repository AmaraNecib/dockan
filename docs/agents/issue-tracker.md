# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI.

## Common operations

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`; also check its labels.
- List: `gh issue list` with the needed `--state` and `--label` filters.
- Comment: `gh issue comment <number> --body "..."`
- Change labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Run `gh` from this checkout. It resolves the repository from the GitHub remote.

## Pull requests

PRs are not an issue-triage surface. Keep the `PRs as a request surface` setting off.

## Wayfinder

- The map is a GitHub issue labelled `wayfinder:map`. It holds Notes, Decisions-so-far, and Fog.
- Create child tickets as GitHub sub-issues when available. Otherwise, add them to the map's task list and start each child body with `Part of #<map>`. Use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Record blockers with GitHub issue dependencies. Use a `Blocked by: #<number>` line only if dependencies are unavailable.
- Work the first open, unblocked, unassigned child in map order. Claim it with `gh issue edit <number> --add-assignee @me`.
- Resolve it with a comment, close it, then add a context pointer to the map's Decisions-so-far.
