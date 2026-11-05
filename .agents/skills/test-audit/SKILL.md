---
name: test-audit
description: "Audit whether tests detect reachable contract failures. Use when the risk-selected review calls for a test-quality lens."
---

# Test audit

This lens assesses test quality; the review tier in `docs/engineering-workflow.md` decides when it runs. One reviewer execution covers the audit. Do not launch a default specialist panel. Ask another reviewer only to resolve a concrete question that source inspection cannot answer.

## Read and trace

Pin the base and head supplied by the caller. Read changed test files, corresponding source, direct callers and the test-value rubric in `../tdd/SKILL.md`. Follow each acceptance behavior through a realistic caller to the observable result.

For each proposed gap, show reachability, the contract at risk, why current tests miss it, and the cheapest adequate test with an independent expected result. For a proposed duplicate, name the surviving test, input, setup and assertion that detect the same failure. Similar syntax, shared code, test counts and line coverage do not prove equivalence.

Check for non-vacuous setup, awaited assertions, isolation, deterministic scheduling and application-level outcomes. Mocks and timers alone are not grounds to remove a test. Treat unproven reachability or missing detection as a hypothesis; preserve existing coverage until evidence proves it redundant.

## Report

Save a concise report to `.scratch/reviews/<issue-id>/<head-sha>-test-audit.md`. Each finding names its test or source location, the consequence and the smallest correction. Keep supported defects separate from hypotheses. Reviewers return findings; the authoring session makes changes and reruns affected tests.