---
name: code-review
description: "Review a fixed diff against project standards and its acceptance spec. Use for a local or PR review, with test adequacy included when the review tier requires it."
---

# Code review

One reviewer execution covers two axes. Keep them distinct in the report.

## Pin the review

Use the fixed point supplied by the caller. Record `git diff <fixed-point>...HEAD` and `git log <fixed-point>..HEAD --oneline`. Confirm both refs resolve and the diff is non-empty before reviewing.

Find the acceptance source in this order: issue reference in commit messages, user-provided path, matching design/spec under `docs/`, `specs/` or `.scratch/`. If none exists, report that and assess the stated acceptance goal without inventing requirements.

## Review both axes

Read the complete changed files, relevant callers and project standards. Report only findings with a reachable consequence and a `file:line`.

- **Standards:** cite a documented rule when the diff violates one. Fowler's code smells are judgment prompts, not hard failures; repo standards override them, and tooling-enforced issues do not belong in the report.
- **Spec:** identify missing or partial requirements, unrequested behavior, and incorrect implementations. Cite the acceptance source for each finding.
- **Test adequacy:** when the selected review tier requires it, name the changed contract and caller, then identify the test's independent expected result. Treat unproven gaps as hypotheses, not demands for more tests.

Keep each finding under the axis that supports it. State the smallest fix. Do not invent command output, test results or reviewer executions. A separate reviewer is justified only by a concrete unanswered question; name that question first.

## Report

Use `## Standards` and `## Spec` headings. List findings with severity, location, consequence and fix. If an axis has no findings, say so. End with finding counts and the most serious issue under each axis.