# Reviewloop and Greptile comparison

Run both systems for each reviewed PR during this trial. Continue across PRs until the owner chooses which path to keep after examining several PRs. A PR count is a checkpoint for discussion, not an automatic replacement of either reviewer.

## Paired runs

1. Pin the same base SHA and head SHA for both reviews. Start both as soon as their prerequisites allow, concurrently when possible. Local reviewloop checks still precede the push; hosted Greptile starts after it. Record that timing difference rather than claiming simultaneous execution.
2. Save each system's original findings and score before reading the other system's findings or making a fix. Reviewloop lenses read the author brief, not Greptile's verdict. If either result was exposed to the other reviewer, label the pair as contaminated and exclude it from first-pass accuracy comparisons. Historical rounds without a saved original result are incomplete samples.
3. Request Greptile once after pushing a new head, with one request per head. An automatic run already covering that head counts as the request. Read its actual summary, reviewed SHA and findings, not just its green check. If its base cannot be verified, record that limitation and exclude the pair from same-boundary accuracy comparisons.
4. Verify every finding against the pinned code. Record a shared defect once, credit both reviewers when both found it, and record which reviewer found a verified unique defect. Fix real defects before merging. A fix moves the head and requires fresh review evidence, not relabelled reports.
5. Publish the comparison in a PR evidence comment with the head SHA and the `<!-- crew-evidence -->` marker. Keep detailed reports in ignored `.scratch/reviews/<issue>/`. Update the evidence comment when the round finishes.

## Merge rule during the trial

Both current-head reviews must be 5/5 with no actionable findings, alongside the existing CI and merge gates. Scores are not averaged. A disagreement requires investigation even when one score is green. A missing verdict, refusal, exhausted credit or failed provider is an incomplete gate, not permission to choose the other result. Preserve completed work and record the blocked PR in `.scratch/sessions/awaiting-external-review.md`; do not repeat requests to consume more credit.

This is a parent-operated review protocol, not a new GitHub Actions workflow or an automatic comparison service. The renderer still scores only reviewloop. The parent checks Greptile separately and verifies that both verdicts cover the head being merged.

## Evidence per PR

Use one row per paired head and review stage. Keep first-pass results separate from post-fix results; re-reviewing the same PR does not add another PR to the sample. Record different review scopes and model-family exceptions so they do not look like equivalent independent runs.

| Field | Record |
| --- | --- |
| Boundary and scope | PR URL, base/head SHAs, first pass or post-fix, reviewed files, verdict/report links, model and effort for local lenses, independence exceptions and contamination |
| Accuracy | Raw findings, verified defects, verified unique defects by reviewer, shared defects, false positives with code-backed reasons, severity and later verified misses attributed to the reviewed head |
| Time and effort | Request/start/end timestamps, elapsed review time, queue/retry delays, parent verification and fix time when measured |
| Cost and availability | Observed tokens or credits, currency and billing source when available, quota/provider failures; mark unavailable measurements unknown rather than zero |
| Outcome | Both scores, confirmed remaining blockers, fixes and final disposition; separate static inference from executed regression proof |

A reviewer missing a defect is measurable only once that defect is verified. Agreement and a high score are not proof of correctness. Compare confirmed defects found and missed, false-positive burden, time and observed cost across distinct PRs. Show sample size and unavailable measurements. The owner decides when the sample is useful and whether to keep one system or both.
