---
name: greploop
description: >
  Iteratively reviews and improves the current checkout with Greptile. Local mode
  uses the Greptile CLI and never needs a PR, comments, pushes, or GitHub. A
  hosted PR/MR/CL mode remains available only when explicitly requested.
license: MIT
metadata:
  author: greptileai
  version: "2.0"
allowed-tools: Bash(git:*) Bash(greptile:*) Bash(command:*) Bash(gh:*) Bash(glab:*) Bash(p4:*)
---

# Greploop

Iteratively reach a clean Greptile review: confidence 5/5 and zero unresolved
or actionable findings. The default is **local mode** against the pinned base
(`develop`): run `greploop --local`. Hosted PR mode is available when the work
is already on a pushed PR.

Greptile claims are not automatically correct. Read the current file and verify
each finding before fixing or dismissing it. A successful command/check is not a
clean verdict if findings remain.

## Inputs

- `--local` — review the current local checkout with `greptile review`;
- optional issue id — save evidence under `.scratch/reviews/<issue-id>/`;
- optional base SHA — use it for diff context and staleness checks;
- hosted PR/MR/CL number — only for an explicitly enabled remote workflow.

Maximum: **5 iterations**. Stop sooner when the clean exit condition is met.

## Local mode (default for the offline repository)

Local mode reviews the current committed branch diff. The CLI excludes
uncommitted files, so stop and report the review boundary (or make an explicit
local commit of named files) before trusting the result. It does not ask GitHub for
issues, PR comments, checks, review threads, or repository metadata.

### 1. Confirm local context and authentication

```bash
git rev-parse --show-toplevel
git status --short --branch
git rev-parse HEAD
greptile whoami
```

If the CLI is missing, do not install it automatically. Ask for permission and
show:

```bash
npm i -g greptile
```

If authentication is missing, ask the user to finish:

```bash
greptile login
```

Use a locally resolved base (normally `git merge-base develop HEAD`) when
comparing the change; no fetch needed for routine runs.

### 2. Run one review iteration

Prefer JSON:

```bash
greptile review --json --branch <base-branch>
```

Always pass the pinned base branch/ref. Omitting it can make the CLI compare
against the repository default branch and review an unrelated, enormous diff.
If the CLI reports that JSON is unsupported, use:

```bash
greptile review --agent --branch <base-branch>
```

Do not hide a failure. If both commands fail, stop and report the command,
raw error, and the next user action. The result must be tied to the current committed `HEAD`. The CLI excludes
uncommitted files; do not claim they were reviewed. After every code change,
commit the intended files explicitly or report the uncommitted boundary, and
then treat the previous result as stale.

When an issue id is known, preserve the raw result and a summary:

```
.scratch/reviews/<issue-id>/<HEAD>-greptile-local.json
.scratch/reviews/<issue-id>/<HEAD>-greptile-local.md
```

Do not overwrite a result from a different `HEAD`. If reviewable changes are
uncommitted, record the exact boundary plus `git diff --stat` in the summary and
do not call the result clean.

### 3. Parse and classify the result

Report:

- review status;
- confidence score, if present;
- total findings;
- actionable/unresolved findings by severity;
- file and line for each finding;
- findings verified as real, false positive, or informational;
- next fix path.

The local clean condition is:

1. confidence is 5/5 **and** there are zero actionable/unresolved findings; or
2. the CLI explicitly reports no actionable findings and no unresolved issues
   when it does not expose a numeric score.

A green process exit with a 4/5 score or inline findings is not clean.

### 4. Fix the current checkout

For each actionable finding:

1. read the file and surrounding code;
2. verify the claim against current usage and the local spec/design;
3. make the smallest correct fix;
4. add or strengthen a regression test when appropriate;
5. run the relevant local checks;
6. update/recreate code-review and test evidence if a reviewable file changed;
7. run the next local Greptile iteration.

For a false positive or informational item, record the reason and line-level
verification in the summary. Do not silently dismiss it.

Local Greploop must **never**:

- run `gh`, `glab`, or `p4` APIs;
- post PR/MR comments or resolve hosted review threads;
- push, shelve, create, edit, or merge a PR/MR/CL;
- run `git add -A` or stage unrelated files (named-file local commits are allowed
  when needed to make the reviewed `HEAD` explicit);
- treat an old result as current after a code change;
- claim that a local result closed a ticket.

The parent agent owns edits and decisions. Greploop is a review/fix protocol,
not permission to broaden the issue scope.

### 5. Stop conditions and report

Stop on the first clean result or after five iterations. Also stop immediately
if the CLI/authentication fails, the result is missing/stale, or a fix requires
files owned by another active worktree and the owner has not approved it.

Local output:

```text
Greploop complete (local).
  Checkout: <branch>
  Iterations: 2
  Confidence: 5/5
  Findings fixed: 4
  Remaining actionable: 0
  Evidence: .scratch/reviews/<issue-id>/...
```

If the loop stops at the limit or on a failure, list the remaining findings,
exact files/lines, the last reviewed HEAD, and the next action. Say explicitly
that the work is local and has not been pushed or merged.

## Hosted mode (when the work is already a pushed PR)

Hosted mode reviews an open PR instead of the local checkout. Select the
platform from the remote and identify the PR/MR, then follow the platform's
greptile check, comment, inline-thread, and resolution APIs. Before using it:

- verify the repository and credentials are reachable;
- verify the PR/MR base is the intended `develop` ref;
- compare the review result's commit to the latest commit;
- inspect comments/threads, not only the check status;
- after a fix, push and wait for the new review rather than reusing stale output.

Hosted mode may commit and push only with explicit user authorization and must
still stage named files rather than using `git add -A`. Its merge/close rules
remain subordinate to `AGENTS.md` and the user; Greploop never merges on its
own.
