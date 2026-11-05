---
name: reviewloop
description: >
  Reviews a branch or PR without Greptile: runs the risk-sized local review selected
  for the change, extracts findings from required lenses, and renders the
  Greptile-shaped summary, inline comments and confidence score. Use for a lane's
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

Use this for the current-head review in `feature-implement`. It executes the risk-sized local review selected in `docs/engineering-workflow.md`; it never replaces local review with hosted-only review.

## Modes

| Mode | Who runs it | Writes |
|---|---|---|
| local (default) | any lane | `.scratch/reviews/<issue>/` only; no push, no PR, no GitHub write |
| PR | parent only | the rendered body as a PR comment, inline payloads as review comments, a check run on the head |

A lane never pushes and never posts. It hands the head SHA and renderer result to the parent. Local artifacts
from a lane are unverified until the parent checks the exact base/head, reviewer session, actual model family, provenance and report for each required lens. A valid worker execution on the exact tree is reused, not automatically duplicated. The parent verifies findings and renders current evidence. Step 12 publishes the local review and handles hosted findings.

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

Pick one model per lens from the session's enabled review routes. Use the provider/model
catalogue, not a hard-coded provider ladder.

**OpenCode review is optional.** `opencode` and `opencode-go` are opt-in routes, even when their
models appear in the catalogue. Run them only when the owner requests or explicitly enables
them for the current scope. Do not automatically probe them, install a CLI, switch after a
quota failure, or ask the owner to opt in for each PR. Their absence does not make the review
incomplete. An existing owner decision remains in force for its stated scope.

Independence is a family, not an ID: free and paid DeepSeek are the same family. Use a family
other than the author's, and at least two families across multiple lenses, unless the owner
approved an exception below. Evaluate availability among enabled routes only. A catalogue
entry is neither permission to use a provider nor proof that it works.

For an enabled route that has not answered recently, run a one-line probe before the round.
A failed probe stops that route, not the other enabled routes.

Run the locally required review for every reviewable change, with depth selected by reachable risk under `docs/engineering-workflow.md`. Compact Standard is one focused `code-review` execution covering Standards, Spec and affected-test adequacy; mark `debate` and `test-audit` skipped with reasons. Ordinary Standard uses all three lenses; High-assurance requires all three and final-head debate after fixes. Record exactly what ran; the renderer accepts explicit skips but refuses an all-skipped round. Compact is never no-review or hosted-only.

**Standing owner approval:** when OpenCode is unavailable, same-family review is allowed
without asking again per PR. Unavailable includes disabled, not opted in, quota-limited
or failed routes. Optional probes are not required. Prefer an enabled working non-author
family; otherwise use separate reviewer sessions. This approval also covers using one
family across multiple lenses. Disclose that these are separate executions, not
model-family-independent reviews, and record the actual availability reason:

```json
"independence": { "approvedBy": "owner", "reason": "Standing owner approval: OpenCode unavailable; same-family separate-session review" }
```

A lane records this owner approval, not its own. It waives neither required lenses nor
current-head 5/5, finding resolution, verification or merge gates. For a condition outside
this standing scope, obtain explicit owner approval. The renderer prints the exception in the review and writes
`<!-- reviewloop_independence_exception -->` into the body.

**Done when** the chosen pairs pass the guard in step 4.

### 3. Run the selected lenses

Run only the lenses required by the selected depth. Compact Standard runs one focused `code-review`; ordinary Standard runs `debate`, `test-audit`, then `code-review`; High-assurance runs all three and a final-head debate after fixes. Each required lens is its own reviewer execution, uses its selected model and saves a report to `.scratch/reviews/<issue>/<head>-<lens>.md` with the full head SHA. Only the critic/defender inside `debate` and specialists within another lens may parallelize. `code-review` covers Standards and Spec; include affected-test adequacy for compact review.

Each lens reads the existing author account first, if present. Every report opens with two lines, nothing between them:

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

Write `.scratch/reviews/<issue>/<head>-findings.json`. Keep one entry per verified
defect per lens comment; never collapse agreement during extraction. Assign the
same `id` to entries from different lenses only after verifying that they describe
the same defect. The renderer merges entries with that shared ID in the same file
when their start lines differ by at most one, across lenses only. Entries without
IDs or with different IDs stay separate. Two findings from one lens also stay
separate, however close their lines are.

For example, two lenses that independently report the same P2 produce two P2
entries with one shared ID. `dedupe()` merges them into one P1 finding, so the
score is 4/5. A single pre-collapsed P2 entry would incorrectly leave the score
at 5/5.

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

Choose whether the summary needs a diagram using the
[diagram guidance](../../../docs/review-diagrams.md). Add Mermaid source to
`summary.diagram` whenever an accurate diagram can be made, even if it repeats
the summary. Omit it only with a reason in `summary.checks` when the pinned code
cannot support an accurate diagram. Verify its edges. Summary and Diagram are
independently collapsible and open by default; confidence, findings and fix
prompts stay enabled, all verified severity levels are included, and passing
still requires 5/5.

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
`summary.dismissed`. A lane may extract a local draft; the parent verifies each
execution and finding before pushing. A worker claim alone is not evidence. The
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

### 5. Verify and resolve findings

Every finding is a claim. Read the cited code and verify it. Fix a valid blocker in this PR when bounded; split substantial work and hold dependent work until the blocker is resolved. Dispute a stale or factually wrong finding with code evidence and obtain reviewer resolution. A parent cannot unilaterally dismiss a valid finding as optional or addressed. A genuinely nonblocking improvement is optional only when the reviewer accepts that disposition and applicable gates allow it. A finding raised by one lens remains a finding even if others missed it.

The rendered score is not enough: no unresolved actionable finding may remain at any score. An unresolved finding cannot be hidden in `summary.dismissed` or overridden by a numerical score.

**Done when** every finding has a verified resolution and any dispute has reviewer resolution.

### 6. Loop on the new head

Any fix moves the head, and evidence for the old head is stale. Re-run steps 2-5
on the new head: the lenses, not just the renderer.

Stop only at **5/5 with no unresolved actionable findings**, or after five iterations. A fifth round that still has an unresolved finding is blocked and reported to the owner; do not award a clean verdict.

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

PR mode, parent only: follow the [native finding-thread protocol](../../../docs/review-findings.md).
Post `<head>-review.json` as one native GitHub review pinned by `commit_id`, with
anchored findings as code-linked threads. Reuse existing threads for that head,
link them from the summary, and verify fixes before resolving them. Outdated is
not proof of a fix. Keep outside-diff findings visible with pinned source links.
Publish measured evidence separately with the evidence marker and set the head's
check from the renderer exit code. A review comment alone is not the scored gate.

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
- A worker's claim alone does not certify a lens. The parent verifies the exact-tree execution, actual reviewer session/model and report. Reuse a valid execution; rerun only when evidence is absent, invalid or stale.
- `.agents/wisdom/` is read before the round and never written by a lane.

### What is committed

- `tools/reviewloop/render.ts` and this skill are tracked. The rule and the
  prompt live where a lane cannot edit them mid-review.
- `.scratch/reviews/**` stays untracked; it is already gitignored. The evidence is
  for `guard` and the next reviewer, not for the PR. A committed report is a file
  the reviewer reads instead of the code, and every new head makes the previous
  one stale.
- The durable record is the rendered PR comment, which carries the head SHA.
