---
name: test-audit
description: "Audit test quality using 3 specialized sub-agents: edge case hunter, coverage analyst, and quality reviewer. Use after debate and before code-review — catches shallow test coverage that 'all tests pass' misses. Standard and High-assurance."
---

# Test Audit — 3-Agent Test Quality Review

## Parameters

The caller (feature-implement) provides:
- **base SHA** — the merge-base commit to diff against
- **issue ID** — for the evidence file path
- **head SHA** — current HEAD, for the evidence file path

## When to run

After debate (implementation is finalized) and before code-review.
Required for **Standard and High-assurance** changes. What escalates a change to
High-assurance is defined once, in `docs/engineering-workflow.md` (Review tiers);
do not restate it here.

## How to run

### 1. Determine what to audit

Identify the test files for the changed code using git diff pathspecs:

```bash
git diff <base-sha>...HEAD --name-only -- '*.test.ts'
git diff <base-sha>...HEAD --name-only -- ':!*.test.ts' ':!__tests__/**'
```

### 2. Launch all 3 agents in parallel

Each agent reads the test files, corresponding source and relevant callers, plus [TDD's test-value rubric](../tdd/SKILL.md#test-value-rubric). Apply that rubric to every candidate; test count and line coverage alone establish neither a gap nor a duplicate.

**Agent 1: Edge Case Hunter**
```
You are an EDGE CASE HUNTER. Read tests, source and relevant callers.
For each candidate edge case:
- Trace a realistic caller input to the observable contract.
- Show the contract violation and why existing tests miss it.
- Propose an independent expected result at the cheapest adequate layer.
- Rate impact, including rare security, money, backup and race failures.
Treat unproven reachability or missing detection as a hypothesis, not an automatic demand for another test.
```

**Agent 2: Coverage Analyst**
```
You are a COVERAGE ANALYST. Read tests, source and relevant callers.
Evaluate:
1. Map acceptance criteria to named tests and assertions; identify gaps.
2. For a proposed gap, establish reachability, contract impact and missing detection.
3. For a proposed duplicate, name the surviving test, input, setup and assertion that detect the same failure. Similar syntax or a shared code path is not proof.
4. Report before/after coverage for proposed consolidation and the targeted discrimination check needed before weakening an assertion.
```

**Agent 3: Quality Reviewer**
```
You are a TEST QUALITY REVIEWER. Read tests, source and relevant callers.
Check independent expected results, non-vacuous setup, awaited assertions,
isolation and deterministic clocks/scheduling. Distinguish application contracts
from implementation mirrors or framework-only checks. Mocks and timers are not
deletion evidence. Report each defect with its location, consequence and fix;
keep unsupported concerns separate as hypotheses.
```

### 3. Wait for all 3 to finish

Collect all outputs.

### 4. Synthesize

| Finding type | Action |
|-------------|--------|
| Reachable contract violation missing detection | Fix it with a discriminating test |
| Unproven reachability, impact or missing detection | Investigate the hypothesis; retain existing coverage |
| Proven duplicate coverage | Consolidate only with named surviving coverage and discrimination evidence |
| Misleading name, vacuous setup or coupled oracle | Fix it without losing the contract assertion |
| Missing await, isolation or scheduling defect | Fix the harness; preserve the behavior check |

### 5. Save evidence; the authoring session applies the fixes

The lens returns findings; it does not write to the worktree. The session that
authored the change fixes everything classified as "Fix it" and commits, and the
lens re-runs on the result when the tier requires a fresh look.

Save findings to `.scratch/reviews/<issue-id>/<head-sha>-test-audit.md`.

The caller (feature-implement) will publish a summary as a PR comment after
the PR is opened.
