# Red-on-parent gate — design review (grilled, not built)

Issue: red-on-parent gate · Tier: Standard (CI/pre-push wiring; no failure-mode diff)
Date: 2026-10-19 · Reviewed head: local commit on `t3/design-red-on-parent-gate`

**Verdict (spoiler): build it at a small scope.** The idea survives the grill
because bun's actual behaviour — measured below, not assumed — happens to split
"failed for the right reason" from "failed because it couldn't even load" well
enough to automate. The gate earns its keep only for **new** test files, needs
a cheap legal-waiver escape hatch, and must treat a load error as a hard stop:
never a silent pass, and a pass only where a waiver names the test.

## Glossary (definitions this doc commits to; promote to CONTEXT.md only if the owner approves the gate)

- **Vacuous test** — green on every source tree it can be run against, including
  the parent of the change that adds it.
- **Right-reason red** — the selected test fails on the parent because the
  behaviour it pins does not exist there. An `AssertionError` on the selected
  test name.
- **Wrong-reason red** — the run fails on the parent without evaluating the test
  body: missing module, missing named export, syntax error, check-for-build
  artifact. Indistinguishable from a right-reason red by exit code alone.
- **Waiver** — a declared, reviewer-visible exception: "this test is green on
  the parent on purpose, here is why."

---

## 1. What bun actually does (measured in a scratch directory on 1.4.2 and re-measured on 1.4.3, which is the repo's `packageManager` pin)

Probes ran in `D:\tmp\bunprobe` (round 1, bun 1.4.2) and in a scratch directory
under `.scratch/tmp/` (round 3, the downloaded 1.4.3 binary), both outside the
tracked tree. Each printed the raw output and `PIPESTATUS[0]`. Summary table
first, evidence below. **The pin at `bff7a1a9` and later is `bun@1.4.3`** — an
earlier version of this doc said 1.3.14, which no CI run has ever used.

Round 3 re-measured the junit shapes on the pinned 1.4.3, because the whole
premise of this design is measured semantics and the earlier table named a
version the repo does not run:

| test shape | junit `type` on 1.4.3 | `assertions` |
| --- | --- | --- |
| `expect(1).toBe(2)` | `AssertionError` | 1 |
| `expect(...).toThrow("ZERO")` mismatch | `AssertionError` | 1 |
| `assert.equal(1, 2)` (node:assert) | `AssertionError` | 0 |
| `throw new Error("boom")` in the test body | `Error` | 0 |
| `throw new Error("x")` in `beforeEach` | `Error` | 0 |
| `throw new Error("x")` in `beforeAll` | `Error` | 0 |
| `expect.fail(...)` | `TypeError` (`expect.fail is not a function`) | 0 |

Consequence for the rule: on 1.4.3 the failure `type` alone separates a hook
throw from an assertion red, and the `assertions` counter separates nothing (it
is 0 for a `node:assert` red as well). The gate therefore decides on `type`. A
counter rule was in the shipped code for one round on the strength of a 1.3.14
probe where every failure was typed `AssertionError`; on the pin it misread a
genuine `node:assert` red as a wrong-reason red. That is the kind of fact this
doc's own refusal rule exists to stop.

The residual hole, stated because junit cannot close it: an assertion that
fails *inside a hook* is indistinguishable from one that fails in the body
(`expect` in a hook gives `AssertionError` + `assertions="1"`; node:assert in a
hook gives `AssertionError` + `"0"`). No counter rule catches the first shape
and the second only by accident, which is what the old rule bought.

| Question measured (1.4.2, re-checked where it moved) | Answer |
| --- | --- |
| Select one test by name | Yes — `bun test <file> -t "<pattern>"` filters by regex against the test name; non-matching tests print `(filtered out)`/`skipped`. The junit `testcase name` attribute is the **test name only**, no `describe` chain (P10). |
| Exit code: failed test | `1`. Output has a `(fail) <test name>` line and, with `--reporter=junit`, `<failure type="AssertionError">` on that testcase (P2, P7b). |
| Exit code: load/collection error (missing module, missing named export, syntax error) | Also `1` — **the exit code does not separate the two**. Load errors print `# Unhandled error between tests`, an `error:` block, counts ` N pass / N fail / N error`, and **no junit file is written at all** (P1, P3, P4, P6, P7). |
| `-t` pattern that matches nothing | Exit `1` with `error: regex "..." matched 0 tests. Searched 1 file (skipping 2 tests)` — a typo'd pattern cannot silently pass (P5c). |
| Does the file load before or after `-t` filter? | **After.** A file whose imports fail, run with `-t` matching nothing, reports only "matched 0 tests" — the `Cannot find module` never surfaces (P6b). With a matching test, the load error surfaces and kills the run (P6). |
| Failure inside `beforeEach` (imports resolve) | Prints a `(fail) NEW: <name>` line exactly like an assertion failure, but junit's failure `type` is `Error`, not `AssertionError` (P9). Confirmed on 1.4.3. |
| Type-only imports of types that don't exist on the parent | Erased by transpile; the test runs and passes (P11). Typecheck is not part of `bun test`, so TS-only breakage cannot colour this gate. |
| Single-file runtime cost in this repo | ~0.2 s wall for one file (cold, after `bun install`), 118 ms inside bun. |

Evidence snippets (abridged, full transcripts in the probes):

```
-- P2 right-reason red --                      exit 1
(fail) real red rejects non-positive [0.34ms]
 0 pass / 1 fail / 1 expect() calls

-- P3 missing named export --                  exit 1, no junit file
# Unhandled error between tests
SyntaxError: Export named 'guard' not found in module '...\src\helper.ts'.

-- P5c -t typo --                              exit 1
error: regex "NO-SUCH-PATTERN" matched 0 tests. Searched 1 file (skipping 2 tests)

-- P7b junit, right-reason red --
<testcase name="NEW: guard rejects zero" ...>
  <failure type="AssertionError" ...>

-- P9 hook throws --                           exit 1, (fail) line present
<failure type="Error" ...>   ← NOT AssertionError
```

Consequence: the gate can classify every outcome with two signals —
(1) was a junit file written? (2) did the selected test produce
`<failure type="AssertionError">`? Text parsing as a fallback is also viable
(`(fail) <name>` present AND no `# Unhandled error between tests`), but the junit
`type` attribute is less brittle than scraping coloured terminal text. Since
1.4.3, `--reporter=junit` refuses to run without `--reporter-outfile`, so the
gate always passes the path explicitly.

## 2. False positives — a green new test on the parent, legitimately

The pattern for every row: the gate misclassifies an honest test, the author
pays a token, and if tokens are too common the waiver becomes a rubber stamp.
Scope matters: **only *new* test files (absent at the merge-base) are gated.**
Never edited ones. That single scope decision deletes the worst classes.

| Legitimate case | What the gate sees | What the author pays |
| --- | --- | --- |
| Characterization test for behaviour that already worked (pure refactor PR) | Green on parent → gate blocks | Waiver with one reason line. This is the intended UX; cost is one comment line and a reviewer glance. |
| Test documenting an existing invariant | Same | Same. |
| Test whose setup needs a helper the change introduces (`makeTestUser`) | Wrong-reason red (parent lacks the helper module) → gate hard-fails with "the parent could not load this file" | Two options, both real payments: land the helper on the **base branch** in its own change and rebase, or waive + inline the fixture locally in the test. A commit *inside* this change does not help: the parent is the merge-base, so the module is still missing there. |
| Test-only helper fix PR (fixes a broken helper, no behaviour change) | If it adds a new test file, that file likely pins the fixed helper → green or wrong-reason red | Waiver, or scope the PR to edits of existing tests only (which the gate then never touches). Rare; acceptable. |
| Plumbing: file moved/renamed, its tests move with it | New file at new path; import path resolves only on the change → wrong-reason red | Waiver ("moved file") or keep tests in place. Common in rename PRs; the waiver names the pattern, so it is narrow. |
| New dependency + new test for it | Green on parent (the test imports the new dep; parent source never did, so nothing about the parent eagerly loads it) | Waiver with "new dep" as reason. Or run the test first, then wire the dep — same waiver either way. |
| Test data/fixture improvement, i18n copy addition, screenshot fixtures | Usually newly-created files that exercise existing behaviour | Waiver. Watch this class in copy/UI-heavy PRs: it is where waiver fatigue starts. |

Cost honesty: in a normal bug-fix PR (1–3 new test files in one package), the
expected burden is zero waivers and one red. In refactor/copy PRs it can be
3–10 waivers of the "behaviour already worked" kind. If reviewers see that
block, the gate converts from a vacuity check into a waiver-collection form.
Mitigations baked into the design: new-file-only scope, the waiver reason is
must-have text, and the gate output puts every waiver in the printed table so a
reviewer can't miss that a PR waived its way past.

**The gate does not judge the dominant shape, and that is a known payment.**
A change that adds a *source module* and a test for it puts the parent in the
"wrong-reason red" row above: the module is not there, the file cannot load,
and the only way past is a waiver. The waiver is per test, so the report names
each one, and the last line says `PASS (n waived)` — but the gate has judged
nothing about those tests, because the parent could not run them. That is the
price of a merge-base parent, and it is paid on every PR of that shape.

**Known limits of the source scan.** The gate finds a file that imports another
test file by reading the source, because bun names every testcase after the
entry file and the report cannot say whose case it holds. The scan reads the
TypeScript AST, not the text: `import` / `export … from` / `import X = require`
and the `require(…)` / `import(…)` call nodes. A commented-out import is not a
node, so it cannot be reported; the string, regex and JSX shapes that a text
scan has to mask away never reach it. Two spellings were added after the AST
reader landed and are read like any other: a no-substitution template specifier
(``import(`./a.test.ts`)``) and a call whose specifier is the first of several
arguments (``import("./a.test.ts", { with: { type: "text" } })``). `require` is
recognised bare, qualified (`module.require`), element-accessed
(`module["require"]`) and parenthesised (`(require)`).

Its limits are the ones the AST cannot answer. **Only relative specifiers
(`./`, `../`) are read**, so an alias the package resolves through `tsconfig`
paths — `@/lib/fixtures.test.ts` — is invisible. A specifier held in a variable
(`await import(name)`) is not read either. Both are false failures at worst: the
gate refuses a file it cannot attribute, never accepts one it cannot.

The scan reads the added file's own imports, so an import *through* a helper —
the added test imports `shared.ts`, and `shared.ts` imports another test file —
is not seen, and that second file's cases land in the report as the added file's
own. The junit cannot close this: measured on bun 1.4.2, a run whose entry
`a.test.ts` imports `b.test.ts` writes `file="a.test.ts"` on **every** testcase,
including the one `b.test.ts` declared. So `parseJunit`'s `onlyFile` filter —
which does separate two *entries* that bun's substring filter both matched, such
as `cart.test.ts` and `cart.test.tsx` — returns nothing for the contributing
file and cannot attribute a thing. The gap needs the loud version: a refusal,
like the direct import, or a scan that follows the helper. (`parseJunit` has no
caller that passes `onlyFile` today; the gate imports exactly the file it
judges.)

**Known limit of the red's attribution.** A hook that *throws* on the parent
reports `<failure type="Error">` and is read as a wrong-reason red. A hook that
*asserts* reports `AssertionError`, exactly like a test body, and is read as
the test's own red. The two are indistinguishable in the junit: the report names
the failing line, and a helper a test body calls fails at that helper's line
too, so "the red came from a shared hook" and "the red came from the test's own
helper" look the same. Measured on bun 1.4.2, the two reports differ only in
the line the stack names (the hook's line, before the testcase's line, against
the body's line, after it), which is a rule that would also misread the helper
case. The gate therefore states the limit instead of guessing at it: an
assertion in a hook is treated as the test's own red, and a test whose body
would have been green on the parent is not caught here. Closing it needs the
enclosing function of the failing line, which a line-based source scan does not
give.

## 3. False negatives — how a vacuous test still slips through

1. **Wrong-reason red accepted as a pass — the sharp one.** A test importing an
   export that only exists in the change fails on the parent with
   `SyntaxError: Export named 'guard' not found`, exits 1, and signals zero
   assert lines. Exit-code-only gates pass it, making the gate useless.
   **Measured answer: bun separates it.** Wrong-reason reds produce no junit
   file (or a junit with no `<failure>` on the selected test); right-reason reds
   produce `<failure type="AssertionError">` on the selected name. Gate rule:
   require the junit-file + AssertionError signature, else fail the gate with
   "your test failed to load on the parent; wire up the missing fixture or
   default the export before you push." This is the load-bearing rule.
2. **Hook-body throw, not an assertion. Measured: this is nearly invisible.**
   P9 produced a `(fail) NEW: <name>` terminal line — same text shape as a real
   red — but junit's `type` is `Error`, not `AssertionError`. If the gate only
   greps `(fail)`, this passes. The junit type check catches it. Note the
   residual risk: a right-reason red that legitimately throws a non-assertion
   error from the body itself (`throw new Error` inside test body rather than
   `expect(...).toThrow`) would be misclassified as wrong-reason. Chosen
   side-effect of the rule: it forces `expect(...).toThrow("...")`, which is
   also just a better test. Gate prints both classifications so an author who
   created a legit non-assertion red can see exactly what happened.
3. **Tautological assertions inside a well-formed test.** `expect(1).toBe(1)`,
   snapshot of a constant, `expect(config).toBeDefined()` after a load
   succeeds — these qualify as right-reason reds or get a waiver. **No
   mechanical gate can catch this class.** The gate's contribution is that the
   author must reason at the waiver, and the reviewer sees the waiver names; it
   does not prove non-vacuity, it makes proving it someone's job.
4. **Non-deterministic/coincidental red.** Date seed, random, and `Date.now()`
   can fail on the parent for a reason unrelated to the change, laundering a
   vacuous test through a legitimate-looking red. Also flips around: today's
   red becomes tomorrow's gate-fine PR after someone else's rebase. Only
   defence is review; scope-wise this is rare in unit tests.
5. **`-t` pattern broader than intended.** Pattern `"NEW"` also matches future
   tests named `NEW: ...`, and the gate's "must fail" requirement is then
   satisfiable by the wrong test failing. Mitigation: the gate pins the pattern
   to the full test name of each test the diff adds (regex-escaped so special
   characters don't leak), not to a free-form prefix.

## 4. The design, final

**Scope — one job, one scope.** Gate only **new** test files (paths added by the
diff, resolved via merge-base `git diff --name-only merge-base...HEAD`). Never
edited test files. Excludes e2e (`tests/e2e/**`, Playwright) — an e2e spec
whose red-on-parent check needs both servers is out of unit-scope cost.

**Marker (the escape hatch).** A single-line comment at the bottom of the test
file, keying on the same `-t` patterns the gate will run:

```ts
// red-on-parent-waive: "NEW: guard rejects zero" — characterizes pre-existing guard behaviour in a rename PR
```

- The waiver names the exact test-name pattern it excuses and a reason sentence
  (this is what a reviewer reads in the diff, not a broad file-level "skip the
  gate").
- No waiver key → the gate demands a green-on-parent failure for every test
  whose name matches an added test.
- Multiple tests can share one waiver line or have separate ones.
- Waived tests are still *run* against the parent; they just drop out of the
  "must be red" check. Why: if a waived test actually *is* red on the parent,
  the gate says "your waiver claims green-on-parent but this test already
  fails there — delete the waiver and keep the red," which is a cheap honesty
  check that costs nothing extra and catches copy-paste waivers.

**Where it runs.** A script at `scripts/red-on-parent.ts` (bun only, no
dependencies: `Bun.spawnSync` for git/bun, regex over the junit XML). It runs:

1. **locally in Guard Phase 2** (pre-push, invoked by `guard`) — the author
   owns fixing or waiving before anything leaves the machine;
2. **in CI on the head commit** against the merge-base — a CI check
   `red-on-parent` that cannot be bypassed by a local skip because CI does
   the base-read from origin's `develop`, so the two runs agree on what "the
   parent" is.

Three placements (Design, Guard 2, CI) all call the same script; there is no
separate CI logic to drift.

**Algorithm.**

```
1. Find merge-base with develop (default; overridable for stacked PRs).
2. Resolve added test files from `git diff --name-only <base>...HEAD`
   (filter: *.test.ts under apps/|packages/, skipping e2e).
3. Generate one entry file per added test file: it imports the added file by
   its own relative path and nothing else, so bun's report holds that file's
   cases and no other file's. (The design first sketched a static list of the
   added test names and a `-t` pattern; bun's positional argument is a
   *substring* filter, so `cart.test.ts` also matches `cart.test.tsx`, and the
   cases of a file the gate is not judging land in the report. The entry file
   removes the filter instead of escaping it.)
4. Prepare a base worktree once per base SHA, cached:
   git worktree add <tmp>/<base-sha> <base-sha>
   bun install --frozen-lockfile in the worktree (~1 min cold; the design first
   sketched a junction to the main checkout's node_modules, and a junction
   cannot serve a change that adds a dependency, so the install is real)
5. Copy ONLY the added test files into the base worktree at their own
   relative paths. This is the load-bearing subtlety: running a test file by
   absolute path from the change's checkout would resolve its imports
   against the change, not the parent, and the gate would test nothing.
   Then, cwd = base worktree:
      bun test <entry file> --reporter=junit --reporter-outfile=...
   and the same file is run again on the change side, in the change's checkout.
6. Classify per test:
   - the run did not finish (timeout, spawn error)  → RUN INCOMPLETE (fail; no waiver)
   - junit absent                                 → WRONG-REASON RED (fail)
   - junit testcase <failure type="AssertionError"> → RIGHT-REASON RED (pass)
   - junit testcase passed                        → GREEN ON PARENT → waiver needed
   - junit testcase <skipped>                     → GREEN ON PARENT → waiver needed
   - a test the change registers and the parent's report never names →
     NOT ON PARENT → waiver needed. The change's own run supplies the names,
     because the parent's report is only a subset of what the file declares.
   - the same test fails on the change as well      → RED ON CHANGE (fail; no waiver)
   - the same test is skipped on the change         → SKIPPED ON CHANGE (fail; no waiver)
   - the parent's run registered a test the change's run did not → NOT ON CHANGE
     (fail; no waiver)
   - the added file imports another test file       → the file is REFUSED: it
     was not judged, and no waiver covers that, because a report that mixes two
     files cannot say whose case failed
7. Waivers are read from the change's test file text; evaluated in step 6
   before deciding to fail. The change side's verdicts are decided on the
   change's own results: a waiver says why the parent could not run a test,
   not that the test works on the change.
8. Print the table (file / test / verdict / waiver) and, under FAILURES, the
   message each failing verdict carries. Exit 1 on any WRONG-REASON RED, any
   green without waiver, any NOT ON PARENT, any RUN INCOMPLETE, any RED ON
   CHANGE, any SKIPPED ON CHANGE, any NOT ON CHANGE, and on any problem the run
   could not judge. Exit 0 on all red or all waived-with-red-check-clean.
   Exit 2 when the gate could not run at all: a usage error, a runtime that is
   not bun, a lock it could not take, or an unexpected error.
```

**Failures the author sees.** Each verdict prints what to do, not "gate
failed":

- `WRONG-REASON RED: your new test cannot even load on the parent. Its import
  resolution fails ('Cannot find module ...' in the base worktree). Options:
  land the helper module on the base branch in its own change and rebase — the
  parent is the merge-base, so a commit inside this change is still after it —
  point the gate at a parent that already has it (`--base <rev>`), or add a
  red-on-parent-waive line if the module existence IS the change (rename PRs).
  Transcript: <stdout, trimmed to the error block>.`
- `GREEN ON PARENT, NO WAIVER: test '<name>' passes on the parent commit
  (<base-sha>). Either the test pins pre-existing behaviour — add
  red-on-parent-waive '<pattern>' — <reason> — or the change does not make the
  behaviour it seems to test.`
- `WAIVER MISFILED: waived test '<name>' actually FAILS on the parent. Delete
  the waiver line; the red you were looking for is already there.`
- `NOT ON PARENT: the change registers test '<name>' and the parent's run never
  reported it, so there is no red to judge. Build the test so the parent
  registers it too, or waive it with the reason the parent cannot.`
- `RUN INCOMPLETE: the test run did not finish (<timeout or spawn error>), so
  there is no result to judge. Re-run the gate; no waiver covers this.`
- `RED ON CHANGE: test '<name>' fails on the change as well, so it pins nothing
  the parent can be asked about. Fix the test; a waiver cannot cover it.`
- `SKIPPED ON CHANGE: test '<name>' is skipped on the change, so it never runs
  there. Run it, or make the parent skip it too.`
- `NOT ON CHANGE: the parent's run registered test '<name>' and the change's run
  did not, so the change does not execute it. Make the change register it.`
- `FILE REFUSED: the added file imports another test file, so one run would
  report that file's cases as well and the gate could not tell whose test
  failed. Keep each file's cases in its own file; no waiver covers this.`

**Runtime cost, honestly.** Per PR, not per push:

| Component | Measured/estimated |
| --- | --- |
| `git worktree add` from local objects (cached per base SHA) | seconds |
| `bun install --frozen-lockfile` in the cached base worktree | ~1 min cold, once per base SHA; the cache makes later runs free |
| `bun test <entry file>` per touched file, twice (parent side and change side) | ~0.2 s warm per file (measured on this repo's smallest file); heavier integration-style tests cost more, maybe 1–5 s each |
| Total, typical bug-fix PR (1–3 new test files) | **under 2 minutes warm**; a few minutes on the first run of a session or a cold install |

This is far inside any notice-me budget, and ordering the gate after the suite
in CI means its extra cost is dwarfed by the turbo test run it sits beside.
Do not run it on every push: the worktree cache makes re-runs cheap anyway,
but the required input — the merge-base — does not move between pushes, so
there is no reason to pay for it twice in the same session.

**What the CI step's timeout can and cannot promise.** The gate's worst case is
one cold install (10 minutes) plus two runs per file at the test timeout. A
step timeout below that budget is unreachable configuration: the job ceiling is
reached first, and the steps after the gate do not run. The CI placement is
therefore the owner's call, and the diff lives in `.github/`, which this
repository reserves for the owner.

## 5. Verdict

**Build it at unit-test scope, new test files only, with the waiver + the
junit-type discriminator, wired into both Guard Phase 2 and CI.** The probe
results carry the yes: bun's junit `type="AssertionError"` signature is a real,
machine-readable split between "my test body rejected the missing behaviour"
and "my test file could not even load," which is exactly the distinction this
gate needs and the one that would otherwise sink it. The escape hatch is cheap
enough that honest PRs (refactors, copy, new fixtures) pay one comment line
instead of being forced to fabricate a red.

**What I would cut before building anything else:**

- No mutation-testing. This gate is not Stryker; one red-on-parent per added
  test is the entire ambition. Build the cheap 80%-case, not the tool that
  mutates mutants.
- No blocking on the waiver reason being keyword-searchable or linted. The
  reviewer reads it; the gate only checks absence-presence and that the
  waived test isn't red.
- No automatic rebase behaviour, no auto-fix, no auto-generate-waiver. If the
  gate starts writing the waiver for the author, the waiver becomes history.
- No support for edited test files, snapshot tests, or Playwright specs in
  phase 1. Edited files are where the false-positive cost lives; leave them
  to the debate/test-audit lenses, which already run on every Standard+ PR.

**If the answer to any one probe came back differently, I would say "don't
build it":** if load errors and assertion errors had both been invisible under
junit (each slipping past the other's signature), the gate could not operate.
Both signals measured intact. The idea survives.

## Lessons applied from `.agents/wisdom/`

Read before starting; applied: creature-of-habit review-tier discipline
(Standard, tier recorded above), evidence-with-SHA convention (probe outputs
quoted, scratch location named, no repo changes), scope-search discipline for
the probes (all in `D:\tmp\bunprobe`, nothing in the repo touched). No lesson
applied: none of the api/data/e2e category wisdom bears on a null-repo-change
design doc.

## ADR note

If the owner approves this as built, one ADR records it: wiring a
red-on-parent gate into CI is hard to reverse once it starts failing real PRs
and is surprising without context ("why does my honest refactor PR need a
waiver?"). Format and location per the domain-modeling skill; write it when
the gate becomes code, not before.

## Review evidence pointer

This is a design artifact only; no repo files changed. Probes are scratch and
in `D:\tmp\bunprobe`. Reviewing-lane evidence should record this head SHA
per the convention in `.agents/skills/guard/SKILL.md`.
