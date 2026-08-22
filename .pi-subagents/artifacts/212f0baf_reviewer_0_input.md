# Task for reviewer

[Read from: D:\projects\mani-project\plan.md, D:\projects\mani-project\progress.md]

You are the Standards reviewer in a two-axis code review, in D:/projects/mani-project on branch feat/01-persistence-backbone.
Run these to see the change:
git diff main...HEAD
git log main..HEAD --oneline
Review ONLY the repository source: apps/api/src/**, packages/contracts/src/**, oxlint.config.ts, package.json files. Ignore everything under tools/, .scratch/, docs/, bun.lock, and node_modules.
Documented standards sources: CONTEXT.md (domain vocabulary, at repo root), docs/adr/0001..0003, README.md. Note: tool-enforced rules (oxlint with anti-slop plugin, TypeScript strict, bun test) are already green; skip anything tooling enforces.
In addition, apply this fixed smell baseline (Fowler, Refactoring ch.3). Each is a labelled judgement call, not a hard violation; a documented repo standard overrides it.
Mysterious Name -> rename; Duplicated Code -> extract shared shape; Feature Envy -> move the method onto the data it envies; Data Clumps -> bundle fields into one type; Primitive Obsession -> give the concept its own small type; Repeated Switches -> replace with polymorphism or one shared map; Shotgun Surgery -> gather scattered edits into one module; Divergent Change -> split so each module changes for one reason; Speculative Generality -> delete until a real need shows; Message Chains -> hide the walk behind one method; Middle Man -> cut it, call the target direct; Refused Bequest -> drop inheritance, use composition.
Report, per file/hunk where relevant: (a) every place the diff violates a documented standard, citing the standard (file + rule); (b) any baseline smell: name it and quote the hunk. Distinguish hard violations from judgement calls. Under 400 words.

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