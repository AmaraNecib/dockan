---
name: reviewloop
description: >
  Reviews a branch or PR without Greptile: runs the debate, test-audit and
  code-review lenses on model families other than the author's, extracts their
  findings, and renders the Greptile-shaped summary, inline comments and
  confidence score the rest of the workflow already reads. Use for a lane's
  review round, to replace a Greptile review, when a new head invalidates the
  evidence, or when the user asks for a review comment or confidence score.
---

# Reviewloop

A review round that produces the artifact the workflow already greps for: one
confidence score out of 5, ranked findings, inline comments where a line can be
anchored, and an outside-diff list where it cannot. The shape is not invented
here; it is the one in `.scratch/reviews/<issue>/<head>-greptile-local.json`, so `cli-review`,
`greploop`, `guard` and the 5/5 merge gate keep reading it unchanged.

Two things are mechanical rather than promptable, and `tools/reviewloop/render.ts`
enforces both:

- **The author's family never reviews.** A lens recorded on the same model family
  as the author is refused: free and paid DeepSeek are one opinion.
- **The score is a ceiling.** It is computed from the findings; an override can
  lower it with a reason and cannot raise it.

Use this for the review round in `feature-implement` step 12. The lens steps before
it stay where they are, unless the tier skipped them and this run is the only
review.

## Modes

| Mode | Who runs it | Writes |
|---|---|---|
| local (default) | any lane | `.scratch/reviews/<issue>/` only; no push, no PR, no GitHub write |
| PR | parent only | the rendered body as a PR comment, inline payloads as review comments, a check run on the head |

A lane never pushes and never posts. It stops at the local half of step 7 and
hands the head SHA and the renderer's exit code to the parent. Local artifacts
from a lane are drafts. Before pushing, the parent reruns the required lenses,
verifies their findings and renders current evidence. Step 12 publishes that
review and handles hosted findings; it is not the first local render.

## Steps

### 1. Pin the boundary

The issue id, the base (default `develop`), and the head (`git rev-parse HEAD`).
The tier comes from `docs/engineering-workflow.md`; it sets the required checks
and scrutiny.

**Done when** both refs resolve and `git diff <base>...<head> --stat` is non-empty.
An empty diff is a bad ref, not a clean review.

### 2. Name the reviewers

Read the lane's commit trailer for the author, not the parent's model:

```bash
git log -1 --format=%B      # the Model: trailer, e.g. "Model: pi/opencode-go/deepseek-v4.1-flash"
```

A hand-written commit carries no trailer; then the author is human and every
model is independent. Record `"authorModel": "human"`.

Pick one model per lens from the ladder, free first:

| Rung | Models |
|---|---|
| Free | `opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free`, `opencode/mimo-v2.6-flash-free`, `opencode/beam-free` |
| Paid, only when the free routes are exhausted | `opencode-go/deepseek-v4.1-flash` ($0.15/M), `opencode-go/mimo-v2.6-flash` ($0.14/M) |

Independence is a family, not an ID: `deepseek-v4.1-flash-free` and
`deepseek-v4.1-flash` are the same opinion. The author's family never reviews,
and with two or more lenses at least two families must appear. With a DeepSeek
author, GLM, MiMo and Beam are the free choices.

An advertised route is not always a working one: a model this session has not
answered with recently gets a one-line probe before the round.

Run the lenses the parent scoped; the default at Standard and above is all three
(`debate`, `test-audit`, `code-review`). One or two are enough when the change
touches a single axis, and the payload records exactly what ran, so the artifact
never claims a lens that did not. A lens that genuinely has nothing to read is
`skipped` with the reason, never silently dropped; all three skipped is not a
round, and the renderer refuses it.

When every non-author family is exhausted, a round on the author's family is
possible only with the owner's explicit approval, recorded in the payload:

```json
"independence": { "approvedBy": "owner", "reason": "only DeepSeek is available this week" }
```

Try every other family before asking. A lane cannot grant this approval to itself.
The renderer prints the exception in the review and writes
`<!-- reviewloop_independence_exception -->` into the body.

**Done when** the chosen pairs pass the guard in step 4.

### 3. Run the lenses

Dispatch the chosen lenses in parallel, each on its chosen model, each loading its
skill and saving its report to `.scratch/reviews/<issue>/<head>-<lens>.md` with
the full head SHA in the name. The lens skill spawns its own sub-agents; the
model you name is the one they run on. The lenses:

- `debate` — critic and defender, for design and failure modes.
- `test-audit` — edge cases, coverage, test quality.
- `code-review` — standards and spec, two axes reported separately.

Each lens reads the author review first, if one exists, and treats its "what the
author knows is weak" list as a checklist rather than a verdict. Every report
opens with two lines, nothing between them:

```
Reviewer model: <provider/model that actually ran>
Author model:   <the lane's Model: trailer>
```

The renderer reads those lines and refuses a report that leaves them out, or
whose models contradict the payload. The IDs must be the ones that ran, not the
ones the round intended. Each finding names a `file:line`; a lens that writes
prose without a location has not finished.

**Done when** every lens listed in the payload has a report, and every finding in
those reports carries a location.

### 4. Extract the findings

Write `.scratch/reviews/<issue>/<head>-findings.json`. One entry per distinct
defect, not one per lens comment. Assign the same optional `id` to entries only
after verifying that they describe the same defect. The renderer merges entries
with that shared ID in the same file when their start lines differ by at most
one, across lenses only. Entries
without IDs or with different IDs stay separate. Two findings from one lens also
stay separate, however close their lines are.

```json
{
  "authorModel": "pi/opencode-go/deepseek-v4.1-flash",
  "lenses": [
    { "name": "debate", "model": "opencode/glm-5.3-flash-free", "report": ".scratch/reviews/312/<head>-debate.md" },
    { "name": "test-audit", "model": "opencode/mimo-v2.6-flash-free", "report": ".scratch/reviews/312/<head>-test-audit.md" },
    { "name": "code-review", "model": "opencode/beam-free", "report": ".scratch/reviews/312/<head>-code-review.md" }
  ],
  "summary": {
    "impact": "High",
    "what": "One line: what the change does.",
    "verdict": "One line: what blocks the merge, or \"\".",
    "summary": "A paragraph for the Summary section.",
    "bullets": ["What the change adds, by behaviour."],
    "checks": "What was and was not run.",
    "dismissed": [{ "title": "A finding that is real but accepted", "reason": "Why it does not block." }],
    "diagram": "flowchart TD\n  A --> B"
  },
  "findings": [
    {
      "id": "stock-draft-refresh",
      "lens": "debate",
      "severity": "P1",
      "title": "Edited stock stops updating",
      "path": "apps/web/src/pages/items.tsx",
      "line": 855,
      "endLine": 857,
      "body": "What is wrong, naming the call site that proves it.",
      "fix": "What to do instead.",
      "suggestion": "```suggestion\n...\n```",
      "evidence": "apps/web/src/pages/items.tsx:912 reads draft.row and never refreshes it."
    }
  ]
}
```

`impact` is the blast radius of the change, not the worst finding: a vault
migration with one P2 is still `Critical`. `evidence` is the file:line outside
the diff that proves the finding, or `self-evident: <why the hunk is enough>`;
P0 and P1 are refused without it.

`lenses` lists what actually ran, one to three. Every finding's `lens` must name
one of them; the renderer refuses an attribution to a lens that did not read the
diff, and a skipped lens does not count as having read it. When the owner approved
an independence exception, add
`"independence": { "approvedBy": "owner", "reason": "..." }` at the top level.

Before rendering, account for every report finding in `findings` or
`summary.dismissed`. A lane may extract a local draft; the parent repeats that
verification before pushing. The
renderer does not reconcile report prose with the payload or authenticate an
`approvedBy` string. It records the owner's decision, not proof of approval.

The renderer also opens each report, because a path is not evidence on its own. It
requires the exact filename `<head>-<lens>.md` and refuses one that does not open
with the two model lines, and one whose `Reviewer model:` or `Author model:` does
not match the payload. That is the check that `lens.model` is the model that ran,
rather than the model the round intended.

Then run:

```bash
bun tools/reviewloop/render.ts --issue <id>
```

`--head` and `--base` override the refs; the head resolves to a full commit SHA
before naming the input and output files. `--worktree` exits 2 without writing:
uncommitted content cannot produce commit-pinned evidence. Commit the reviewed
files and omit that flag. Unrelated dirty files are not part of the committed
review. `--print` writes the body to stdout; `--json` prints `{ body, created }`
for a consumer that expects the CLI contract.

**Done when** the renderer exits 0 or 1. Exit 2 means the review was refused or
could not finish; read the message and fix its cause. Partial artifacts from a
failed run are not approval. Do not work around the guard. Exit 2 in particular covers a diff that
could not be read, one that is empty, and one whose file headers cannot be parsed:
a round with no readable boundary is not a review of anything, and it must not
produce a 5/5 artifact. A diff that only deletes files, only renames them or only
changes their mode is not empty and renders normally — every touched path counts
as reviewed even when it has no added line. Exit 2 also covers invalid JSON, wrong field types and unreadable reports, so
an input failure cannot look like "findings remain". A raising score override,
invalid flag or unsupported filename also exits 2, as does a failed artifact write.

### 5. Verify, then fix or dismiss

Every finding is a claim, not a fact. Open the file at the line and confirm the
code still says what the lens says it says. Then either fix it, or dismiss it
with a reason in `summary.dismissed` naming what you read that made it safe.

A finding one lens raised and the others missed is still a finding. Verify it
against the code; silence is not a second opinion.

A successful test run is not a clean verdict while an unverified finding remains.

**Done when** every finding has a verdict, and every dismissal has a reason.

### 6. Loop on the new head

Any fix moves the head, and evidence for the old head is stale. Re-run steps 2-5
on the new head: the lenses, not just the renderer.

Stop at **5/5 with no P0 or P1**, or after five iterations. A fifth round that
still finds something is a finding for the user, not for a sixth round.

**Done when** the renderer exits 0, or you report the remaining findings and the
iteration count.

### 7. Report

During the trial, run this review beside Greptile using the
[comparison protocol](../../../docs/review-comparison.md). Preserve each system's
unexposed findings and record verified defects, false positives, time and cost.
The parent checks both current-head verdicts before merging. Continue across PRs
until the owner decides which path to keep; this renderer does not score Greptile.

Local mode: the head SHA, the score, the finding counts, and the paths the
renderer wrote. Nothing is committed.

PR mode, parent only: post `{ body }` as a PR comment, post one review whose
`comments` array is `<head>-inline.json`, and set a check run on the head whose
conclusion follows the exit code. The check is what makes the score a gate
instead of a note.

## Reference

### Severity

| Level | Meaning | Test |
|---|---|---|
| P0 | Data loss, a security hole, or a production path that cannot start. | Can a user lose data or reach what they should not? |
| P1 | Ships wrong behaviour, or bypasses a gate the change was meant to keep. | Will someone notice in use, not in review? |
| P2 | Real but non-blocking: a misleading diagnostic, a doc that contradicts the code, a test that passes for the wrong reason. | Would the next person be misled? |

Severity is the damage the finding does, not how sure the lens is. A confident
nit is still a P2.

### Score

| Findings | Score |
|---|---|
| two or more P0 | 1 |
| one P0 | 2 |
| two or more P1 | 3 |
| one P1 | 4 |
| P2 only, or none | 5 |

Two lenses agreeing on a shared defect ID on the same or adjacent lines promote a P2 to P1
and stop there; P0 is reserved for evidence of real damage. `scoreOverride` may lower the result with a
written reason and may never raise it.

The rule reproduces the band in the saved reviews — one P2 scored 5/5, one
P1 with five P2s scored 4/5 — not Greptile's judgement, which scored the same PR
3/5 and 4/5 at consecutive heads with one P1 at both.

### Independence

- Independence is a model **family**, not an ID: free and paid DeepSeek are one
  opinion. The author's family never reviews, and the renderer refuses it.
- With more than one lens, at least two families must appear. Three lenses on one
  family are one opinion counted three times.
- A round on the author's family needs the owner's written approval in
  `independence`; the review states it and the body carries a marker. A lane
  cannot approve its own exception.
- A lens reports; it does not edit the worktree and does not take the e2e slot.
- A lane cannot certify its own lens. The parent re-runs it and records that.
- `.agents/wisdom/` is read before the round and never written by a lane.

### What is committed

- `tools/reviewloop/render.ts` and this skill are tracked. The rule and the
  prompt live where a lane cannot edit them mid-review.
- `.scratch/reviews/**` stays untracked; it is already gitignored. The evidence is
  for `guard` and the next reviewer, not for the PR. A committed report is a file
  the reviewer reads instead of the code, and every new head makes the previous
  one stale.
- The durable record is the rendered PR comment, which carries the head SHA.
