# Code-review lens — PR #297, the `red-on-parent` gate at `8a618ed9`

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

**Base** `bff7a1a9d9d15b59470bd2452a61e180b90c4b6a` · **Head reviewed** `8a618ed9` · **Lens** `code-review`, run as two independent sub-agents: one against the repository's documented standards, one against the design document the gate was built from.

**Method.** Both sub-agents read the **commit** `8a618ed9` through `git show`, cited `file:line` against that commit, and wrote nothing. The standards agent read `docs/verification-and-merge-gate.md`, `docs/engineering-workflow.md`, `AGENTS.md` and the `.agents/wisdom/` files that cover the areas the diff touches. The spec agent read `.scratch/implementation/red-on-parent-design.md` and the issue body. Both ran on the review model, not the author's.

**Grades.** The standards agent reported one blocker, four should-fix and two nits. The spec agent reported four should-fix and three nits. Eight of the fourteen findings are closed here or in the round 14/15 work in the same tree, three are closed as a matter of record (the design document and the header now say what the code does), one is deferred with its reason, and two are the owner's to decide.

---

## The standards agent

### S1 · blocker — the comment-stripping half of the import fix had no test and no mutant — **CLOSED**

The import fix has two halves: the statement-based clause test and the comment strip. The clause half was pinned (A17). The strip was pinned by nothing — the only committed comment assertions were type-only clauses, which the clause test already skips, so they pass with the strip deleted. The reviewer checked this outside the repo: it replaced `withoutComments(source)` with `source` and re-ran every `importedTestFiles` assertion in the committed suite. All fourteen returned identical results. The mutant survived.

The commit body claimed "each claim ships with a mutant that dies on it". For this claim it did not.

**Closed in round 16.** `importedTestFiles("// import \"./old.test.ts\";\\n")` is now asserted to be empty, with a block comment and with a real import under a commented one, and mutant **A39** replaces the strip with the raw source and dies on them.

### S2 · should-fix — the waiver-before-refusal reorder shipped with no test — **CLOSED**

The commit body claimed the waiver marker of a refused file is parsed before the refusal. Nothing pinned it: the malformed-waiver assertions were unit tests of `parseWaivers` alone, and the one fixture that imports another test file carried no waiver line. Moving the parse back below the refusal left every assertion green.

**Closed in round 16.** A new fixture's file both imports another test file and carries a malformed marker line; the report must name the malformed marker ("must read") *and* the refusal, and the run must fail. Mutant **A40** moves the parse back below the refusal and dies on it.

### S3 · should-fix — the branch shipped review evidence that was stale for its own head — **CLOSED**

The two committed evidence files carried `6c45f2f5`, five commits behind the head, and the reviewable files had changed since — so guard phase 2 would flag both as stale and the branch could not pass the gate as committed.

**Closed.** This file, `8a618ed9-test-audit.md` and `8a618ed9-debate.md` are the evidence for the head the lenses reviewed, and the two `6c45f2f5` files are removed from the tree. The history keeps them.

### S4 · should-fix — the evidence named the wrong reviewer model, and the design doc did not carry the new policy — **CLOSED**

The committed evidence named `opencode-go/deepseek-v4.1-flash` — the author's own model family — as the reviewer, which the workflow forbids, and neither file carried the two required lines under its title. Separately, the commit body said the new policy (the refusal of a file that imports another test file) "is documented in the gate's header, its error message and the design doc", and at `8a618ed9` the header said nothing about it and the design doc had no such section — the section existed only in the uncommitted working tree.

**Closed.** All three evidence files carry the two lines under the title, naming the model that actually ran. The gate's header now states the refusal and why no waiver covers it. The design doc's "Known limits of the source scan" section and the algorithm's step 6 table carry it, and that section is committed with this change.

### S5 · should-fix — the CI step timeout is not pinned to the script's budget — **PARTLY CLOSED, the rest is the owner's**

`.github/workflows/ci.yml` sets the gate step to 14 minutes, which is exactly the one-file worst case the workflow's own comment computes (a 10-minute cold install plus two 2-minute runs), so the single-file case has no margin, and two gated files need 18 minutes — past the step and past the 15-minute job. Nothing pinned the number: the workflow test asserted only that the timeout is positive and below the job's, so 14 → 3 would keep CI green while killing the gate on a cold install.

**Closed in this commit:** `apps/desktop/scripts/ci-workflow.test.ts` now imports `INSTALL_TIMEOUT_MS` and `testTimeoutMs()` from the script and asserts that the step's budget covers one file's worst case. The numbers come from the script rather than being copied, so the assertion moves when the script's budget does.

**The owner's:** the step timeout and the job timeout live in `.github/workflows/ci.yml`, and `AGENTS.md` reserves `.github/**` for the owner. The proposal is in the commit body of this change: give the gate its own job (`red-on-parent:`, `ubuntu-latest`, `timeout-minutes: 20`, `if: github.event_name == 'pull_request'`) so a wedged gate cannot eat the build and the dependency audit that follow it in `checks`, and so the step's budget is not competing with a 15-minute job ceiling for a 14-minute step.

### S6 · nit — the "Verified" line names commands but no exit codes — **CLOSED**

The workflow's own rule: every gate names the commands it ran *and their exit codes*. The commit body listed the commands and the counts. **Closed**: this commit's body carries the exit code on every line.

### S7 · nit — two claims in the commit body have no ablation behind them — **CLOSED**

The "ignored file survives the reset" claim had an assertion but no mutant, and the ablation runner's own exit-status change had no test at all.

**Closed.** Mutant **A38** (round 16) changes `git clean -fd` to `git clean -fdx` and dies on the ignored file. The runner's exit-status change is evidence tooling under `.scratch/`, which the tier rules call lightweight; it is not counted among the claims that ship with a mutant, and the commit body no longer counts it.

---

## The spec agent

### P1 · should-fix — the import refusal has no waiver, which neither the design nor the issue allows — **CLOSED AS A MATTER OF RECORD**

The design's escape hatch is a waiver, and the design's opening says the idea depends on a cheap legal waiver. The commit's refusal has none, deliberately: a waiver over a report that mixes two files would be a lie.

The spec agent's instruction was to pick one and write it down. The choice made is the refusal, and it is now written down in three places: the gate's header (what is refused, why, and that no waiver covers it), the design doc's step 6 table (the refusal as a fourth row beside the three verdicts) and the design doc's limits section. The issue body's four-verdict list is the owner's to change; the gate's own list now names six verdicts beyond the issue's four, and the design doc carries all of them.

### P2 · should-fix — `RED_ON_CHANGE` is a verdict the spec does not define, and it contradicts the spec's exit rule — **CLOSED AS A MATTER OF RECORD**

The spec's step 8 says "exit 0 on all red"; the code has a seventh verdict that always fails. The behaviour is defensible — a test that fails on the change too pins nothing — but the contract has to say it. The design doc's step 6 table and step 8 exit rule now list `RED ON CHANGE` and `SKIPPED ON CHANGE` and `NOT ON CHANGE` beside the original classifications, and the gate's `VERDICT_GUIDE` carries a fix for each. The issue body's list is again the owner's.

### P3 · should-fix — the design doc is stale on three implemented behaviours, and the commit message says it is not — **CLOSED**

The doc promised a `node_modules` junction (the code always pays a full `bun install --frozen-lockfile`), a `-t` pattern derived from the added file's text (the code selects the file through a generated entry file and runs the whole file), and six classifications (the code has more, and refuses a file).

**Closed.** The design doc now describes the built behaviour: the real install and its cost, the entry-file selection, the verdict table with the refusal row, the exit codes (0, 1 and 2), and a paragraph on what the CI step's timeout can and cannot promise. The commit body's claim is true as committed now, rather than true of the working tree.

### P4 · should-fix — the CI step timeout of 14 minutes inside a 15-minute job can never fire — **THE OWNER'S, WITH THE SPEC AGENT'S REASONING RECORDED**

The comment in the workflow claims a wedged gate "dies here and the build and audit after it still run". It does not: the step is the last thing in `checks` before the web build and the dependency audit, and the 15-minute job ceiling is reached before the 14-minute step ceiling, so a wedged gate takes the build and the audit with it. The gate's real worst case is a cold install plus two runs per file, which is minutes, not the design's "< 1 minute".

**This is the same `.github/**` change as S5** and the same proposal: the gate gets its own job with its own timeout, so its budget is not competing with the 15-minute ceiling and a wedge cannot take the build and the audit. The parent routes the diff to the owner.

### P5 · nit — the report table prints `WAIVED` where the spec's table prints the message — **CLOSED AS A MATTER OF RECORD**

The design's step 8 asks for a message column; the code prints the message under `FAILURES` and puts the waiver list in the fourth column. The design doc now says so, in the step 8 description, so the two do not disagree.

### P6 · nit — `parseJunit`'s file filter has no call site — **DEFERRED, WITH THE MACHINERY KEPT**

`onlyFile`, `enclosingSuiteFile` and `sameTestFile` are unreachable today. The spec agent's instruction was to delete them or say which caller will use them. They are kept, and the header of `parseJunit` now says what the agent could not see: that it has no caller inside the gate today, and that it is the mechanism that closes the helper-import gap the design's limits section names. Deleting it would throw away the answer to a known hole.

### P7 · nit — the header documents an exit code the spec does not have, and the spec's "hard stop" prose is not what the code does — **CLOSED**

The header documents exit code 2; the design did not. And the design's opening says a load error is "a hard stop, never as a pass", while the code lets a *waived* load error pass — which the design's own detailed rules require. **Closed**: the design's step 8 now carries exit code 2, and the opening prose has been reworded to what the code does: a load error fails unless a waiver names the test.

---

## What the spec agent confirmed

The delivered behaviour that matches the design: the scope rule (added files only, never edited ones, no Playwright); the waiver marker's shape and its read from the added file's text; waived tests are still run, and a waiver on an already-red test fails; the `type="AssertionError"` discriminator with the counter recorded but not consulted; the missing junit report as the load-error signal; green and skipped on the parent needing a waiver; `NOT ON PARENT` with the change's own run supplying the names; `RUN INCOMPLETE` with no waiver covering it; the copied files at their own relative paths in a cached per-base-SHA worktree; both wirings (guard phase 2 and the CI step) pointing at the one script; and the exit codes with the file/test/verdict table and every used waiver printed.

## Not checked

- Both agents reviewed the commit `8a618ed9`, not the working tree. Every "CLOSED" line above names the mutant that dies on the fix, or the document that now says what the code does.
- The spec agent did not re-measure bun's behaviour; it took the design's recorded measurements. The two probes this parent ran (the hook assertion and the body assertion) are recorded in the test-audit evidence.
- The `.claude/skills` mirror was checked and is not a finding: neither `guard` nor `feature-implement` is in `skills-lock.json`, so the changed `.agents/skills` files are not mirrored.
- The `.github/**` half of S5 and P4 is not fixed here, because `.github/**` is the owner's. The parent routes it with the diff.
