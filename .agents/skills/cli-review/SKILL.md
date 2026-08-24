---
name: cli-review
description: >
  Runs a Greptile CLI review for the current local branch, installing or authenticating the CLI
  when needed, then summarizes JSON findings for the user. Use when the user wants Greptile
  feedback before opening a PR, outside a hosted PR review flow, or directly from a local checkout.
license: MIT
metadata:
  author: greptileai
  version: "1.1"
allowed-tools: Bash(git:*) Bash(greptile:*) Bash(command:*) Bash(curl:*) Bash(npm:*)
---

# CLI Review

Run a Greptile review from the local checkout and summarize the findings.

This is the review path that works straight from a local checkout. It reviews
the current local branch/diff through Greptile's CLI; it does not need a GitHub
PR, comments, or CI checks. The code may still be sent to Greptile's service by
the CLI, so authentication and network access to the Greptile service are
expected.

## Instructions

### 1. Confirm repository context

Start from the current repository root. Review the current checkout, not a PR
number and not a cached hosted-review result:

```bash
git rev-parse --show-toplevel
```

If the command fails, tell the user that the Greptile CLI review must be run from a git repository.

### 2. Check for the Greptile CLI

Check whether `greptile` is installed:

```bash
command -v greptile
```

If it is missing, do not install it automatically. Ask the user for permission, then show the recommended install command **using the project's own package manager** (detect it from the lockfile: `bun.lock` → `bun add -g greptile`, `pnpm-lock.yaml` → `pnpm add -g greptile`, `package-lock.json` → `npm i -g greptile`):

```bash
# match the repo's package manager (bun here)
bun add -g greptile
```

Do NOT pipe an unpinned remote installer (`curl ... | sh`) to the shell. If a global install via the project's package manager is unavailable (e.g. the environment's tool policy blocks that PM's global-install command), do NOT silently switch to a different package manager or installer — tell the user which PM is blocked and ask them to allow it or install Greptile themselves. If the CLI is already present (`command -v greptile` succeeds), skip installation entirely.

After installation, re-run `command -v greptile`.

### 3. Ensure authentication

Check the signed-in account:

```bash
greptile whoami
```

If the CLI reports that authentication is missing, run:

```bash
greptile login
```

Wait for the user to complete the login flow before continuing.

### 4. Run the review

Prefer JSON output and preserve the raw result when the caller supplies an
issue evidence path (for example `.scratch/reviews/232/<HEAD>-greptile-local.json`).
The output corresponds to the current committed `HEAD` diff. The CLI warns
that uncommitted files are not included; check `git status --short` first. Do
not claim uncommitted changes were reviewed. Commit the intended files explicitly
(or report the uncommitted review boundary) before relying on the result.

Prefer JSON output and pass the pinned local base branch (the CLI option is
`--branch` even though it names the base):

```bash
greptile review --json --branch develop
```

Replace `develop` with the base ref recorded by `feature-implement`. Omitting
it can make the CLI compare against the repository default branch and review an
unrelated, enormous diff.

If JSON output is unsupported or fails with a usage error, fall back to:

```bash
greptile review --agent --branch develop
```

Do not hide the raw command failure if both commands fail. Summarize the failing command and the next action the user needs to take.

### 5. Summarize results

Parse JSON output when available and report:

- Review status
- Number of findings
- Highest severity findings first
- Files that need edits
- Suggested next command or fix path
- Whether the result is **clean** (5/5 and zero actionable/unresolved findings)

A successful CLI exit is not itself a clean review. Inspect the score and every
finding. When output is plain text, preserve the same structure as much as
possible. Keep the summary concise and focused on actionable findings. After
any code fix, run the local checks and invoke this skill again; do not reuse a
stale result.