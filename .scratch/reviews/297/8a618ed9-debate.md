# Debate lens — PR #297, the `red-on-parent` gate

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

**Base** `bff7a1a9d9d15b59470bd2452a61e180b90c4b6a` · **Head reviewed** `8a618ed9` · **Diff** the gate (`scripts/red-on-parent.ts`), its suite (`scripts/red-on-parent.test.ts`), the CI wiring (`.github/workflows/ci.yml`), the design doc, and the workflow invariants (`apps/desktop/scripts/ci-workflow.test.ts`).

**Models.** Critic and defender both `zen-proxy/glm-5.3-flash-free` on provider instance `pi`. Neither is the authoring model. Both were read-only: no file was written by either, no mutating git command was run by either.

**Method.** Three rounds, because the first two did not produce a report.

| Round | What happened |
|---|---|
| 1 (critic) | Read the whole implementation, built scratch fixtures outside the worktree, measured bun's behaviour, and found the lock defects. It then wrote a probe that replicates the gate's own wait loop and hung in it — that loop is an infinite loop by construction, which is finding 2 below. Interrupted. Its findings were recovered from the transcript. |
| 1 (defender) | Read the implementation and the CI wiring and produced nothing for 50 minutes. Interrupted. |
| 2 (critic) | Read the implementation again, spent its whole tool budget collecting line numbers, and its stream died before the report. No findings beyond round 1's. |
| 2 (defender) | Reported. It read the **working tree**, which by then carried the first three fixes of this round, so three of its answers are "already fixed". |
| 3 (critic) | Reported. It read the **commit** `8a618ed9` via `git show`, so its line numbers are that commit's, and three of its findings are the same three fixes the defender called "already fixed". |

**The one disagreement that mattered: which tree.** The critic and the defender were not talking about the same code, and both were right. The defender's "the pre-rename check is there and load-bearing" and the critic's "that line does not exist at `8a618ed9`" are both true — the defender read the working tree, the critic read the commit. Every finding below is stated against the commit, and the synthesis says which of them the fix in this commit already closes.

**The property under test.** The gate must never print PASS while a test was never judged, and it must never print FAIL for a file it never looked at. A false PASS is the worst bug available here.

---

## Critic findings (round 3, against `8a618ed9`)

### C1 · severity 9 · the reclaim verifies the lock *after* it has already renamed it away

Quote (`scripts/red-on-parent.ts:1131` at `8a618ed9`): `renameSync(lockPath, tombstone);` … `1136 const moved = observeLockHolder(tombstone);` … `1142 rmSync(tombstone, { recursive: true, force: true });`

`reclaimStaleLock` returned `void` at `8a618ed9` and had no pre-rename check at all. A lock whose observation was wrong (C3) was renamed away and deleted while its holder was still running; worse, the holder's release deleted **by name** (`1197 return () => rmSync(lockPath, { recursive: true, force: true });`), so it removed the *next* holder's live lock. Two runs then share one base worktree and judge verdicts against a tree the other run is mutating — a false PASS is possible.

Fix: re-observe the lock immediately before the rename and abort if it changed; make the release remove a directory it can prove it still owns.

### C2 · severity 8 · the reclaim path skips the deadline check and the sleep

Quote (`1184-1186` at `8a618ed9`): `if (observed.kind !== "alive") { reclaimStaleLock(lockPath, observed); continue; }`

The `continue` skipped both the deadline check and `sleepSync`. When `renameSync` kept failing — `EBUSY` on Windows for a directory a `bun test` child still holds — the waiter spun at full speed, never read the deadline, and the gate hung forever instead of failing with "wait for it to finish".

Fix: make the reclaim return a status, and on any non-success path fall through to the deadline check and the sleep.

### C3 · severity 7 · every read error on the pid file is read as "there is no pid file"

Quote (`1080-1082` at `8a618ed9`): `try { raw = readFileSync(pidFile, "utf8"); } catch {`

There was no `error.code` test anywhere in `observeLockHolder`. An unreadable pid file (`EACCES`, `EISDIR`, `EPERM`) on a directory older than the grace returned `{kind: "unclaimed"}`, which is reclaimable — which feeds C1 with a live lock.

Fix: `catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "alive" }; … }`.

### C4 · severity 8 · the change side of every verdict is the working tree, not HEAD

Quote (`1428-1435` at `8a618ed9`): `if (modifiedInWorkingTree(repo, file)) { … const result = runFrom(repo, file, junitPath);`

Only the *test file* was checked for uncommitted edits; the modules it imports were not. An author with an uncommitted fix in a source module got a change-side run that passes, so the `RED_ON_CHANGE` row never fired, while the parent side failed with an `AssertionError` → `RIGHT_REASON_RED` → **PASS on a commit whose test is broken**.

Fix: run the change side in a detached worktree at `head`, or fail the run when any tracked file differs from `head`.

### C5 · severity 7 · the gate step's 14 minutes sit inside a 15-minute job ceiling

Quote: `.github/workflows/ci.yml:172 timeout-minutes: 15` (job `typecheck, lint, test, audit`); `:234 timeout-minutes: 14` (step `Red-on-parent gate`).

The job ceiling also covers checkout, install, typecheck, lint, `skills:check`, the whole test suite, the web build and the dependency audit. A job-level timeout **cancels** the job: the gate's table is lost, the check reports "cancelled" rather than "gate failed", and the later `Build web frontend` and `Dependency audit` steps never run either. The script's own `lockWaitBudget` is 10 min install + 2 × 2 min per file + 1 min slack = 15 minutes for a single added file, already over the step's 14.

Fix: give the gate its own job with `timeout-minutes: 20`.

### C6 · severity 6 · a free-text waiver turns a wrong-reason red into a PASS

Quote (`346-347` at `8a618ed9`): `case "WRONG_REASON_RED": return verdict.waiver !== null;`

The parent cannot load the file, so every test in it needs a waiver, so the run passes — and the gate has judged nothing about those tests, because the parent could not run them. Attribution is not verification: the machine cannot tell "the module is new" from "a fixture is missing".

Fix: make a waiver that excuses a load failure name the missing module or export, and check that name against the parent's load error.

### C7 · severity 6 · the import scan matches an import inside a string literal

Quote (`810` at `8a618ed9`): `for (const match of code.matchAll(/\b(?:import|export)\s+([^;'"]*?)\s*from\s*["']([^"']+)["']/gu)) {` — with `withoutComments` keeping string bodies (`737 if (char === '"' || char === "'" || char === "\`") {`).

A fixture string like `const fixture = 'import { a } from "./shared.test.ts"'` matches, and the caller turns that into a **hard problem** — the whole run fails, for a file that imports no test file.

Fix: mask string bodies (offsets preserved) and read the specifier from the original text at the same offsets.

### C8 · severity 6 · the comment stripper does not know regex literals

Quote (`725` at `8a618ed9`): `if (char === "/" && source[index + 1] === "/") {` — there is no regex-literal branch in the whole scanner.

A regex literal holding a quote (`/"/`) opens a "string" at the `"`, which swallows the following text; a `//` comment inside that region is never stripped, so a commented-out import is read as a real import and hits the same hard refusal. False failure, never a false pass.

Fix: mask regex literals in the same pass that masks strings.

### C9 · severity 6 · the "imports another test file" refusal is a hard FAIL that skips the file

Quote (`1569-1573` at `8a618ed9`): `if (imports.length > 0) { problems.push(…); continue; }`

A legitimate layout — a new test importing a shared test fixture file — can never be gated, and `continue` means the file produces **zero verdicts**. The only reason the run still fails is the pushed problem. The refusal rests on a source scan rather than on the report it claims to need: bun's junit `testcase name` carries the individual test's name, so the gate could judge by name and refuse only on a name collision.

### C10 · severity 5 · a hook assertion reads as a right-reason red

Quote (`479` at `8a618ed9`): `return result.failureType === "AssertionError";`

A `beforeEach` that asserts pins nothing about the change, and the gate prints RIGHT REASON RED for it. The hole is stated in the code at `470-476` rather than hidden.

Fix: compare the parent and change reports — a test that fails identically on both sides is not a change-specific red.

### C11 · severity 4 · the per-file junit filter is dead in production

Quote (`251` at `8a618ed9`): `// No file filter: the gate imports exactly the file it judges, so every` — every production call site passes no `onlyFile`; `sameTestFile` (229) and `enclosingSuiteFile` (219) are only reached from the test suite.

The suite therefore proves a path the product never takes.

---

## Defender's verdicts (round 2, against the working tree)

| # | Verdict | The defender's argument |
|---|---|---|
| C1 | PARTLY RIGHT | Per-test attribution is real: the file-level skip is refused by `fileLevelWaiverProblems` when a waiver matches every test in a multi-test file, so one waiver per test is attribution, not a file-level skip. Cheapest fix it proposes: name the missing module in the `WRONG_REASON_RED` detail. |
| C2 | WRONG | "The `continue` is guarded by the reclaim's success — refused/restored/not-stale falls through to the deadline check and the sleep." |
| C3 | WRONG | "A read error that is not `ENOENT` returns `alive`; only a missing pid file is the evidence." |
| C4 | WRONG | "The pre-rename check `if (!sameLock(observeLockHolder(lockPath), observed)) return "refused";` is there and load-bearing." |
| C5 | RIGHT, and worse | The step's 14 minutes sits inside the job's shared 15, which the gate reaches after typecheck, lint, `skills:check` and the whole suite. It proposes giving the gate its own job. |
| C6 | PARTLY RIGHT | The parent is the merge-base, so landing the helper on the **base branch** in its own change *does* move the parent and produce a real red. |
| C7 | RIGHT, measured | A quoted-import fixture is reported as an import; it proposes the code mask. |
| C8 | PARTLY RIGHT | A regex literal does not hide a real import — false positives, not missed imports. |
| C9 | RIGHT | It costs nothing today (`rg` finds no such layout in the repo) and the refusal is stricter than the evidence needs. |

Its score: 7.5/10, with C5 as the only blocker.

**What the defender called deliberate trade-offs**, in its own words: the load-error discrimination (a wrong-reason red is never a pass), the new-file-only scope, the waiver as a reviewer-visible declaration rather than a proof, the merge-base parent, the one-test-file exemption (`if (results.length < 2) return [];`), and the fail-closed dirty tree.

---

## Synthesis — what this commit closes, and what it does not

**Closed by the fixes in this commit** (each with a test and a mutant that goes red):

| Finding | Fix | Test | Mutant |
|---|---|---|---|
| C1 | The pid file carries a token, so a lock is identified by pid **and** token; the reclaim re-observes the lock and refuses when it changed, before it renames; the release removes only the lock this run took. | "a reclaim that judged a dead pid does not touch the lock that took it" | A18, A19 |
| C2 | The reclaim returns `reclaimed` / `refused` / `restored` / `not-stale`; only a `reclaimed` result takes the `continue`, and the deadline check now runs **before** the reclaim, so every path through the wait is bounded. | "a reclaim that cannot rename the lock is waited out, not spun on" | A24, A27 |
| C3 | A read error that is not `ENOENT` is evidence of nothing and reads as `alive`. | "a pid file that cannot be read is not evidence of a dead holder" | A23 |
| C4 | A dirty working tree fails the run closed: `modifiedTrackedFiles` compares every tracked file with HEAD, and the change side is not run against a tree nobody committed. | "an uncommitted source cannot hide a test from the change side" | A21 |
| C6 (the message) | The verdict now names what the parent lacked ("the parent has no `./helper`"), and the last line of a passing report says `PASS (n waived)` — with a line naming how many of those the parent could not run at all. "PASS" alone, next to a table of waived rows, read like the gate had judged those tests. | "the report names what the parent was missing", "a pass that rests on a waiver says so in the last line" | A25, A26 |
| — | A test the change **skips** is not a right-reason red: the change side is read independently of the parent's waivers, and a skipped result is its own verdict (`SKIPPED_ON_CHANGE`), which no waiver excuses. | "a test the change skips is not a right-reason red" | A20 |

**Deferred, with the reason:**

- **C5 (the CI budget) — the owner's call, and it is a blocker.** The fix is a `.github/workflows/ci.yml` change, and this repository sends every `.github/` diff to the owner whatever the class. It also invalidates this evidence under `guard`'s evidence-SHA rule (a reviewable file changed between `8a618ed9` and HEAD), so it is handed over rather than applied. The patch, for the owner: give the gate its own job — `red-on-parent:`, `runs-on: ubuntu-latest`, `timeout-minutes: 20`, `if: github.event_name == 'pull_request'` — with the same `checkout` (`fetch-depth: 0`) and `setup-bun` steps the `checks` job uses, and leave `checks` at 15. `apps/desktop/scripts/ci-workflow.test.ts` reads the gate step out of the `checks` job and asserts the step timeout is below the job timeout, so that assertion moves with it.
- **C6 (the waiver's semantics) — the machine cannot tell "the module is new" from "a fixture is missing".** The report now says so in the open (`PASS (n waived)`, and how many the parent could not run), and the verdict names the missing module. The stronger rule — a waiver that excuses a load failure must name the missing module or export, and the gate checks that name against the parent's load error — is a new rule rather than a bug fix, and it is left for the owner with the design doc's payment recorded.
- **C7, C8, C9 — the source scan's known limits.** A false failure, never a false pass: a file that imports no test file can still be refused. The fix (a code mask with the specifier read from the original text, plus a regex-literal token) is a rewrite of the scanner, and the scanner's edge cases are exactly where a bug would hide a real import — which would be a false PASS. The two shapes are now written into the design doc as known limits, with the fix named.
- **C10 — a hook assertion reads as a right-reason red.** The hole is already stated in the code (`470-476`). The fix the critic proposes (compare the parent and change reports for an identical failure) is a new verdict, not a repair.
- **C11 — the dead `onlyFile` path.** It is the machinery C9's fix would use. Deleting it now would delete the way out of C9.

**The verdict both sides agree on:** the gate's classification core is careful, and neither the critic nor the defender found a path where a file produces zero verdicts and zero problems while the diff added a test. The blockers were the lock (C1, C2) and the change side (C4) — all three are closed in this commit — plus the CI budget (C5), which is the owner's.
