---
name: debate
description: "Run an adversarial review with critic + defender sub-agents on an implementation, design, or PR diff. The critic finds every flaw, the defender argues for the design. The parent agent synthesizes both and decides what to fix, defer, or dismiss."
---

# Debate — Adversarial Review (Critic + Defender)

Run two parallel reviewer sub-agents with opposing goals, then synthesize.

## Parameters

The caller (feature-implement) provides:
- **base SHA** — the merge-base commit to diff against
- **issue ID** — for the evidence file path
- **head SHA** — current HEAD, for the evidence file path

## When to run

The review tier in `docs/engineering-workflow.md` decides whether this lens runs. It is one of three distinct initial sessions for a named High-assurance risk. Routine changes do not run it by default.

## How to run

Read the pinned diff, full changed files, issue/spec and existing design note. In one reviewer execution, make the critic case first: identify reachable defects, risk and unnecessary complexity with file:line evidence. Then make the defender case for the design choices and their evidence. Keep these as two explicit sections in one report; they are roles within this lens, not separate reviewer executions.

A second reviewer is allowed only for a concrete unresolved question. Never claim a defender or specialist ran unless a separate session actually did.

### Synthesize

Go through each critic finding and classify:

| Finding severity | In scope? | Action |
|---|---|---|
| Blocker (8-10) | Yes | **Fix it** — regardless of cost |
| Major (5-7) | Yes | **Fix it** |
| Minor (1-4) | Cheap to fix | **Fix it** |
| Minor (1-4) | Expensive to fix | **Create issue, defer** |
| Any | Out of scope | **Create issue, document in PR** |
| Any | Defender disproved (false alarm) | **Dismiss** — note in PR it was considered |

### 3. Apply fixes — in the authoring session

The reviewers return findings; neither writes to the worktree. The session that
authored the change fixes everything classified as "Fix it" above and commits,
and the lens is re-run on the result when the tier requires a fresh look.

### 4. Document remaining items

For everything deferred or dismissed, each non-dismissed item needs a path
forward — either a fix now, a GitHub issue, or a lesson for the parent to
record.

| Decision | Required action |
|----------|----------------|
| Fixed | Committed — no further action |
| Deferred (expensive or out of scope) | **Create a GitHub issue.** Reference it in the PR. |
| Dismissed (false alarm) | Note in PR that it was considered and dismissed. |
| Pattern worth remembering | **Put it in the report** — the parent owns `.agents/wisdom/` and writes an entry only when the pattern repeats. |

### 5. Save evidence

Save the full findings to `.scratch/reviews/<issue-id>/<head-sha>-debate.md`.
This file is used by guard to verify review completeness before the parent pushes.

The parent session publishes a summary as a PR comment after the PR is opened.

### 6. Proceed

After fixes are committed and deferred items are documented, proceed.
