# Delegation task template

Use this template for implementation, verification and review tasks. Submit the raw task input as readable text with spaces and newlines. Keep long history and evidence in linked files. Give the child only context needed for its task, not the parent's full conversation.

```text
Goal
[One acceptance goal. Link the issue and specification. Include findings verbatim when the task fixes findings.]

Worktree
[Absolute worktree path. State whether this is the assigned existing tree or a fresh isolated tree created by the parent. The child determines and uses this absolute path in every command.]

Base and head
[Base branch and SHA, current head SHA, and the expected comparison range. State whether the child may edit.]

Required reading
[Exact files to read, including AGENTS.md, docs/engineering-workflow.md, relevant skills and wisdom. The child reads each source itself.]

Scope and authority
[Files or behavior owned; preservation constraints; whether the child is an implementation worker or read-only reviewer. Name prohibited publication actions. A reviewer is read-only on the source tree and may write only the explicitly named local report artifact.]

Verification mode
[The explicit mode selected by the parent. State checks inherited from CI and focused local proof required. A full local suite, production build or audit needs a named uncertainty or CI coverage gap. Targeted browser proof also uses the queue; queue availability is not scope authorization.]

Concrete proof
[Exact changed behavior and tests or checks that prove it. For a fix, require an ordinary failing-first focused test against the unfixed behavior, then green after the change. Actual-PR parent replay remains CI-only. Name any evidence path.]

Completion report
[Return absolute worktree path, branch and SHA, changed files, checks and results, evidence paths, unresolved findings, and applied/excluded wisdom. Implementation commits include Model, Thinking, Harness and Agent trailers.]
```

For review tasks, pin the reviewed tree's absolute path and SHA. Keep source writes disabled. Findings must cite `file:line`, severity, evidence and the smallest fix. Do not ask a reviewer to claim test execution it did not perform. Model provenance and author/reviewer family independence follow the existing review policy in `docs/engineering-workflow.md` and `.agents/skills/reviewloop/SKILL.md`.
