---
name: test-audit
description: "Audit test quality using 3 specialized sub-agents: edge case hunter, coverage analyst, and quality reviewer. Use after debate and before code-review — catches shallow test coverage that 'all tests pass' misses. High-assurance tier only."
---

# Test Audit — 3-Agent Test Quality Review

## Parameters

The caller (feature-implement) provides:
- **base SHA** — the merge-base commit to diff against
- **issue ID** — for the evidence file path
- **head SHA** — current HEAD, for the evidence file path

## When to run

After debate (implementation is finalized) and before code-review.
Only for High-assurance changes.

## How to run

### 1. Determine what to audit

Identify the test files for the changed code using git diff pathspecs:

```bash
git diff <base-sha>...HEAD --name-only -- '*.test.ts'
git diff <base-sha>...HEAD --name-only -- ':!*.test.ts' ':!__tests__/**'
```

### 2. Launch all 3 agents in parallel

Each agent reads the test files and corresponding source files.

**Agent 1: Edge Case Hunter**
```
You are an EDGE CASE HUNTER. Read the test files and source code.
Find missing edge cases: empty inputs, boundary values, invalid input,
error states, overflow, zero values, race conditions.

For each missing edge case:
- Name it, show where it could break, write a test snippet
- Rate risk: 🔴 would break, 🟠 subtle bug, 🟡 cosmetic
```

**Agent 2: Coverage Analyst**
```
You are a COVERAGE ANALYST. Read the test files and source code.
Evaluate:
1. Does each acceptance criterion have a test?
2. Are tests diverse or all same pattern?
3. Any duplicate coverage?
4. What's missing?
```

**Agent 3: Quality Reviewer**
```
You are a TEST QUALITY REVIEWER. Read the test files.
Evaluate test names, async handling, setup duplication, assertion quality,
test isolation, readability.
Grade: A / B / C / D.
```

### 3. Wait for all 3 to finish

Collect all outputs.

### 4. Synthesize

| Finding type | Action |
|-------------|--------|
| Missing edge case that would break | Fix it |
| Missing edge case, subtle bug | Fix it |
| Repetitive tests (duplicate coverage) | Remove duplicates |
| Poor test names or structure | Fix it |
| Missing await on async assertions | Fix it |

### 5. Apply fixes, save evidence

Fix all items classified as "Fix it". Commit test fixes.

Save findings to `.scratch/reviews/<issue-id>/<head-sha>-test-audit.md`.

The caller (feature-implement) will publish a summary as a PR comment after
the PR is opened.
