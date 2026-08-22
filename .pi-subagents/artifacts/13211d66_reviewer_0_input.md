# Task for reviewer

[Read from: D:\projects\mani-project\plan.md, D:\projects\mani-project\progress.md]

You are the Spec reviewer in a two-axis code review, in D:/projects/mani-project on branch feat/01-persistence-backbone (local-only tracker, no GitHub).
Run these to see the change:
git diff main...HEAD
git log main..HEAD --oneline
Then read the originating documents:
cat .scratch/dokan-mvp/spec.md
cat .scratch/dokan-mvp/issues/01-persistence-backbone.md
cat .scratch/implementation/01-design.md
Review ONLY the repository source: apps/api/src/**, packages/contracts/src/**. Ignore tools/, .scratch/, docs/, bun.lock.
Report: (a) requirements the spec or ticket asked for that are missing or partial in apps/api/src and packages/contracts/src; (b) behaviour in the diff that was not asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec/ticket line for each finding. Note tickets 02+ are out of scope by design (auth wiring, invoice use-case math). Under 400 words.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```