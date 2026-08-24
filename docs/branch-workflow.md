# Branch Workflow

## Naming Convention

- `feat/<issue-id>-<short-description>`: one feature or ticket per branch, off `develop`
- `fix/<issue-id>-<description>`: urgent repair branch
- `refactor/<issue-id>-<description>`: behavior-preserving restructure
- `agent/<description>`: isolated implementation branch for agent-driven work
- `integration/<description>`: merge-and-verify branch combining multiple agent branches

The issue id is the GitHub issue number (or the local `.scratch/issues/` file number before it
graduates to GitHub).

## Expectations

- Every branch targets `develop` as its base.
- A feature branch states its goal, changed files, validation run (`bun run lint`, `typecheck`,
  `test`, and Rust checks when relevant), and follow-ups in the PR description.
- Integration branches list merged inputs, conflict resolution notes, and the final verification pass.
- If a branch cannot complete validation, the PR states the gap explicitly instead of implying success.
- Squash merges only; never merge without an explicit user instruction.
