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

After implementation is complete but before local verification and code-review.
Only for High-assurance changes (authz core, permissions, denial, security).

## How to run

### 1. Launch both sub-agents in parallel

Both agents read the same context: the diff between base SHA and HEAD, the
full changed files, the issue/spec, and any design doc.

**Critic task:**
```
You are a HARSH CRITIC. Find every flaw, risk, over-engineering, missing edge
case, and design problem. Score each 1-10 (1=minor nit, 10=must-fix blocker).
Be ruthless.

Read: git diff <base-sha>...HEAD -- packages/,
      full changed files, the issue spec,
      .scratch/implementation/<issue-id>-design.md if it exists.

Note: Test quality is evaluated separately by the test-audit skill.
Focus this review on the implementation code itself.

Report each finding with: severity, location (file:line), explanation.
```

**Defender task:**
```
You are a CHARITABLE DEFENDER. Argue FOR the implementation. Find what it does
RIGHT. Defend every design decision. Show why the complexity is justified.

Read: git diff <base-sha>...HEAD -- packages/,
      full changed files, the issue spec,
      .scratch/implementation/<issue-id>-design.md if it exists.

Cite file paths and line numbers. Give a confidence score (1-10) for each
defense.
```

### 2. Wait for both to finish

Collect both outputs.

### 3. Synthesize

Go through each critic finding and classify:

| Finding severity | In scope? | Action |
|---|---|---|
| Blocker (8-10) | Yes | **Fix it** — regardless of cost |
| Major (5-7) | Yes | **Fix it** |
| Minor (1-4) | Cheap to fix | **Fix it** |
| Minor (1-4) | Expensive to fix | **Create issue, defer** |
| Any | Out of scope | **Create issue, document in PR** |
| Any | Defender disproved (false alarm) | **Dismiss** — note in PR it was considered |

### 4. Apply fixes

Fix all items classified as "Fix it" above. Commit fixes.

### 5. Document remaining items

For everything deferred or dismissed, each non-dismissed item needs a path
forward — either a fix now, a GitHub issue, or a wisdom entry.

| Decision | Required action |
|----------|----------------|
| Fixed | Committed — no further action |
| Deferred (expensive or out of scope) | **Create a GitHub issue.** Reference it in the PR. |
| Dismissed (false alarm) | Note in PR that it was considered and dismissed. |
| Pattern worth remembering | **Write to `.agents/wisdom/`** using capture-wisdom. |

### 6. Save evidence

Save the full findings to `.scratch/reviews/<issue-id>/<head-sha>-debate.md`.
This file is used by guard to verify review completeness before push.

The caller (feature-implement) will publish a summary as a PR comment after
the PR is opened.

### 7. Proceed

After fixes are committed and deferred items are documented, proceed.
