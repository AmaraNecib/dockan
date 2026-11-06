# The verification rule and the four-part merge gate

This is the rule a lane must satisfy and the parent session must check before a merge or a
queue decision. It exists so the rule stops living in one person's head and in a chat log.

It is deliberately mechanical where it can be. The parts that can be scripted are scripted —
`crew-mergeable.ts`, `crew-admit.ts` and `crew-queue.sh` — and this document is the reason
those scripts exist. They live in `.scratch/scripts/`, which is harness-local and untracked: a
fresh clone has this document but not the scripts.

## 1. Verification: the evidence depends on the change

**Evidence is always required. Only its form changes.**

| the change | the evidence |
| --- | --- |
| **visual** — anything the eye can judge | before/after images **and** a video at real user pace. A screenshot pair alone does not show a transition, a focus ring or a hover state. |
| **not visual** — logic, a feature, a refactor, a fix | the **measurements**. Not "it works": the failing-first run (red before, green after), the ablation/mutation proof that the new guard actually bites, the before/after numbers, and the decisions taken and why. The automated red-on-parent replay is CI-only. |

An **inert** diff (§3) cannot reach the product, so its measurement is the CI run itself — still posted as the evidence comment reason 4 requires. The form changes; the obligation does not.

The non-visual bar is the owner's own phrasing: *"You want evidence that it was right for you
as the agent."* The parent has to be able to judge the change from the comment alone, without
re-running it. A green check is not evidence that the right thing was built; it is evidence
that something ran. The stable CI job `CI acceptance` fails when a required job
fails, is cancelled or skips without a successful selector proof. It does not
prove that branch protection requires it. Local readiness is not CI acceptance
or merge readiness; the owner must verify required-check enforcement and bypass
policy before routine full local runs stop being required.

### Visual evidence, in its exact form

Required whenever the diff is **visual**, **changes e2e behaviour**, or **changes wording**
(i18n/copy) — anything a person reads on screen, or a test reads back as text. The PR's
evidence comment carries all three:

1. **before/after images** — one row per surface changed, both sides at one display width;
2. **a GIF that plays inline**, at real user pace (30–45 s), recorded at Full HD so it stays
   sharp when GitHub scales it to the comment width;
3. **the video link** — the full-quality mp4 beside the GIF. GitHub strips `<video>`, so the
   GIF is the only thing that plays in a PR comment; the mp4 is the full-speed copy.

Use the repository-owned runner at [`scripts/capture-browser-evidence.ts`](../scripts/capture-browser-evidence.ts) for recording, conversion, validation and provenance. Its contract and invocation are documented in [`scripts/browser-evidence.md`](../scripts/browser-evidence.md). The journey owns UI actions and assertions; the runner owns process and artifact handling. Before and after captures use distinct clean source roots and exact revisions. Never swap tracked source under a running server.

Upload validated PNG, GIF and MP4 files to the public `crew-evidence` bucket under `<project>/<pr>/<head>/<artifact>`. Use the existing authenticated `cf` CLI; `cf` and Wrangler have separate authentication, so a missing Wrangler token does not mean `cf` lacks credentials. Request private credentials only if a `cf` command itself fails authentication. Never print tokens or provision credentials when the existing `cf` login works.

1. Run anonymous command discovery with no account or resource identifiers:
   `cf cli search "upload local file to R2 object storage bucket"`.
2. Check the existing `cf` authentication with `cf r2 buckets list` first. Read the discovered
   command's help by appending `--help` to the full command returned, for example
   `cf r2 objects put --help`. Inspect the public bucket domain with
   `cf r2 buckets domains managed list --bucket-name crew-evidence`.
3. Upload each PNG, GIF, and MP4 with its MIME type:
   `cf r2 objects put <project>/<pr>/<head>/<artifact> --bucket-name crew-evidence --file <local-path> --content-type <mime-type>`.
4. For each public URL, run `curl -fsS -D <headers-file> <public-url> -o <downloaded-file>`.
   Confirm the response `Content-Type` matches the upload MIME type, then compare
   `sha256sum <local-path> <downloaded-file>`. Post the URL only when the hashes match.

Keep the existing bucket and policy unchanged. A screenshot pair alone does not show a transition,
a focus ring or a hover state; a linked mp4 alone does not play.

### What counts as failing-first

A test that never failed proves nothing. The evidence must show the artefact **red before the
change and green after it**, with the failing assertion named. A guard added without a case that
reddens when the guard is deleted is not a guard. Run the guard's mutation against the current
head; an inherited mutation table is an unrun gate.

These ordinary TDD and current-head mutation checks are distinct from the automated red-on-parent replay, which runs only in CI. Do not run or delegate that replay locally or require its local output. Browser-relevant changes follow the selector-first procedure in `.agents/skills/guard/SKILL.md`, including its recorded decision and selected-scope run.

Put evidence already available before commit in the commit message body. Record post-commit verification in `.scratch/reviews/<issue>/<sha>-verification.md` and hand its path and verified SHA to the parent for the PR description. Do not create an evidence-only commit that moves the verified HEAD. Keep other lane notes in `.scratch/reviews/<issue>/<sha>-<gate>.md`. The **PR comment is what reason 4 is judged from**: the parent posts it at the head, with the `<!-- crew-evidence -->` marker in the body. A lane that only writes the commit body produces no comment, so reason 4 fails at merge.

### CI enforces red-on-parent with `scripts/red-on-parent.ts`; a waiver is its only exception

The PR `checks` job runs this gate, and its result must pass before merge. The automated parent-checkout replay is CI-only. Parents, workers (including nested subagents) and reviewers must not run or delegate it locally, or require local replay output to accept a review, push, report or merge. Use the PR `checks` result for this gate; keep ordinary TDD and focused regression tests. Hooks and local pre-push workflows also exclude this replay.

"Red before green" is not an honour system here. In CI, `bun scripts/red-on-parent.ts` reconstructs the
**parent of the change** (the merge-base, not the previous commit) and puts the files the diff adds
into that checkout at their own paths: the added test files themselves, a **hollow** stand-in for each
module they import that the parent does not have, and an **augmented** copy of each module the parent
*does* have that the test imports a name from. It then runs each added test file there. Every test in
an added file must fail on the parent, for its own reason — a real assertion, not a load error and not
a throw from a hook. Playwright specs are out of scope, because their red needs two servers.

A module the parent already has is **kept real and only augmented**: its source is written byte for
byte and stand-ins for the names the change added are appended below it. A hollow there would erase
behaviour the parent really carries, so a test of that behaviour would fail on the parent and be read
as a right-reason red — a false pass. Appending leaves every existing export real, so that test still
passes on the parent, is scored GREEN-ON-PARENT and is rejected. The append is refused when the stand-in
would not load: a `default`, a re-export, an export list, an enum, a namespace, an ambient `declare`, a
destructured binding, a decorator, a parent copy that does not parse, a name the parent's module
scope already binds, or a parent copy that re-exports everything (`export *`) from a module the gate
cannot resolve — promoting a module-local `const` to an export is the ordinary way a module gains a
name, and that declaration cannot be appended twice.

`scripts/**` is in scope. The gate judges an added test file under `apps/`, `packages/` **and**
`scripts/`, because the gate's own suite lives there and a gate nobody tests is the failure mode this
document keeps paying for. A `.spec.ts`, an `e2e/` file, and anything under `tests/` or `docs/` are not
judged.

There is exactly one exception, and it is written into the test file so a reviewer reads it in the
diff:

```ts
// red-on-parent-waive: "<test name pattern>" — <why this is green on the parent>
```

The reason is required. The pattern is a regex matched against the test's display name. The line must
be a line comment standing on its own — whitespace or another comment may precede it on the line,
code may not. The gate accepts a waiver for **four** verdicts and no others:

- **the test is green on the parent, legitimately** (`GREEN_ON_PARENT`) — a characterization test of
  behaviour the change keeps, so a red for it cannot exist;
- **the parent could not run the test** (`WRONG_REASON_RED`) — the module, export or fixture it needs
  is what the change adds, as in a rename or a moved file;
- **the parent's run never registered the test** (`NOT_ON_PARENT`) — it is registered behind a
  condition the change newly satisfies, so the parent's run has no case to judge;
- **the gate could not write a faithful stand-in** (`CANNOT_HOLLOW`) — the module the file imports
  cannot be mirrored or appended to, so the parent cannot load the file at all and nothing there was
  judged.

A waiver cannot excuse a test that is red or skipped *on the change*, a test the change stopped
running, or a run that did not finish. A waiver that matches no test in its file is itself a failure,
and so is a pattern broad enough to cover every test in a multi-test file. The report names every
waiver with its file and line, and its last line prints `PASS (n waived)` along with how many of
those the parent never ran — a PR that waived its way past the gate says so where the reviewer reads
it.

**The one exception to that rule is `CANNOT_HOLLOW`, and it is deliberate.** Its row is the single file
row `(whole file)`, so the only waiver that can clear it is a whole-file one:

```ts
// red-on-parent-waive: "whole file" — <why the parent cannot run this file>
```

The spelling has to be exactly `whole file` — the pattern is compared, not matched, so `"file"`,
`"whole"`, `"."` and `".*"` do not clear it. It is not the bypass the broad-pattern rule exists to
stop, because it names no test and clears nothing silently: the report prints it as a waived
`CANNOT_HOLLOW` row with its reason, which is the truth about that file — the parent could not run it.
The alternative was one waiver per test for one cause, and the broad-pattern rule refuses a pattern
that names all of them at once, which is a gate nobody can satisfy and therefore a gate that gets
bypassed.

### What the gate proves, and what it does not

The gate proves that an added test file **reaches** the change and **fails there**. It does not prove
that the test asserts a behaviour. The report's `STAND-IN` column says which fake a row was judged
against, because the two fakes make two different promises:

1. **hollow** — the change ADDS the module, so the parent has none of it and the gate wrote a
   stand-in with the same export names and no behaviour. A `TypeError` there is the gate's own fake
   being dereferenced — `turboArgs([], "x").args` on a hollow is `undefined.args` — so the body never
   evaluated an assertion about the change, and the row is **wrong-reason red**, not the test's own
   red (#348). What is still accepted on a hollow: an `AssertionError`, including one that only reads
   a const stand-in (`expect(NEW_LIMIT).toBeDefined()` is false against `undefined`), because junit's
   failure type cannot tell it from a real assertion on a value the change computes. The row is
   labelled `hollow` so a reviewer sees which shape it might be; closing that one needs a marker the
   test itself must produce, which changes the gate's contract with every test file.
2. **appended** — the parent HAS the module, so the gate kept its source byte for byte and appended
   stand-ins only for the names the change adds. The parent's real code still runs, so a `TypeError`
   there has a cause the gate cannot see; it stays accepted, and that residual hole is stated here
   rather than hidden in the code.

A file that gets both kinds is judged as hollow: the vacuous dereference is possible, so its
`TypeError` is unproven, and the row names both kinds.

Both remaining acceptances are pinned as fixtures in `scripts/red-on-parent.test.ts`. The asymmetry
is easy to mistake for a bug: `expect(brandNew).toBeDefined()` on a **function** export is green on
the parent (a hollow function exists) and rejected, while the same shape on a **const** export is
accepted. What separates them is what a stand-in can be, not an inconsistency in the gate. A vacuous
assertion is rejected only in the shapes the gate can distinguish.

## 2. The four reasons

A pull request may be merged when **all four** hold. Not three. Any one missing sends it back to
the queue or back to a lane.

1. **The local review confidence is 5/5.** Not 3, not 4. Review depth follows reachable risk, but every reviewable change needs local review. A routine change uses one focused code-review session; a named high-risk failure uses the three initial lenses. `reviewloop` writes the local score. No unresolved actionable finding may remain at any score. Until the owner explicitly ends the [paired trial](review-comparison.md), both current-head verdicts must be 5/5 with no unresolved actionable findings. Request Greptile once per pushed head; a missing verdict blocks merge, including when credit is unavailable. Lean local review does not waive the hosted gate.
2. **`Last reviewed commit` equals the current head SHA.** A verdict anchored to an older commit
   says nothing about the code being merged. A rebase or a fix invalidates the previous verdict —
   re-request the review.
3. **No comment lands after the verdict, except pinned evidence.** The one exemption is a comment
   carrying the `<!-- crew-evidence -->` marker: evidence is supposed to arrive after the review,
   and the marker is how the gate tells it apart from a new finding. Any other comment after the
   verdict means the PR is not settled.
4. **An evidence comment is present**, in the form section 1 requires for that change — and the
   evidence must be **at the head being merged**, not at some earlier commit.

On top of the four: **CI acceptance is green on the current head**, every required CI check is green or legitimately skipped (a correctly gated job reporting `skipped` is fine; a pending or pending-then-cancelled check is not), and the PR is not `CONFLICTING`. The parent verifies effective protection using [Current activation](engineering-workflow.md#current-activation), which records the existing owner acceptance. Only the owner changes protection or accepts bypass; a regression blocks merge.

### What the predicate scripts and what the parent checks

`crew-mergeable.ts` is the deterministic half. `bun .scratch/scripts/crew-mergeable.ts --selftest`
proves the policy with no network. On a real PR it exits non-zero when:

- reason 1 fails (no verdict, or a score that is not 5),
- reason 2 fails (the verdict names no reviewed commit, or names an older one),
- reason 3 fails (a non-evidence comment followed the verdict, or the script cannot tell),
- a check is pending or failing, or GitHub reports the PR not `MERGEABLE` (`CONFLICTING`, or an
  `UNKNOWN` GitHub cannot resolve).

Reason 4 is **not** scripted. For a browser-reachable diff the predicate returns `OWNER` with
`needsVisual=true` and the reason *"attach screenshots/video before asking for the merge"*, which
tells the parent to look for the evidence comment; for a non-visual diff it does not check for a
measurements comment at all. Confirming that an evidence comment exists at the head is the
parent's check, at merge time, every time.

## 3. Then the decision

Two questions decide whether the parent may merge without the owner:

1. **Would undoing it be expensive?** Data written, a published contract, a shipped release.
2. **Did the owner ask to see it, or does it encode a decision?** A default, a policy, wording.

**Visual is a trigger for the evidence, not a veto** (owner decision, 2026-10-17). A visual diff
still auto-merges when it is cheap to reverse — but the parent MUST post the before/after images and
the video at the head first, so the owner can judge it after the fact. Wanting to see one specific
PR before it lands is an owner trigger for that PR.

| the class | who merges |
| --- | --- |
| **CHEAP TO REVERSE** — a follow-up commit fixes it; no data written, no published contract, no shipped release; and the owner has not asked to see it. An **inert diff** (tests, docs, fixtures) is the clearest case, but production code can be cheap too | `AUTO` — the parent merges when the four reasons hold, checks are green or legitimately skipped, and GitHub reports `MERGEABLE` |
| **EXPENSIVE TO REVERSE** — **production code** that writes data, publishes a contract or ships a release — or any **OWNER TRIGGER** below, or the owner said "show me" | `OWNER` |
| **a wrong fact anywhere in the gate** | `REFUSED` — not a judgement call. Fix the fact, or the finding, and re-review |

A PR GitHub already reports `MERGED` **is a fourth outcome**, `MERGED`: a different question, not a
decision, and the predicate reports it rather than answering the merge question.

`AUTO` changes who merges, not what the evidence is: it **waives neither reason 4** nor the evidence
form in §1. Even an auto-merge posts its evidence comment at the head.

### The owner triggers

The parent classifies from the diff. **ANY** hit makes it the owner's:

- **Persisted shape** — a migration, `*.sql`, `schema-version`, a new/changed column or enum, or
  anything that writes rows in a shape a later deploy must read. (Undoing it means a migration back.)
- **Published contract** — `packages/contracts/**`: RPC names, field meanings, the wire format.
- **Money** — balance sign, rounding, tax, totals — any accounting invariant.
- **Security** — auth, secrets, the vault, crypto.
- **CI / release / build** — `.github/**`, release scripts, desktop packaging, version bumps.
- **Outside state** — publishing, deploys, third-party notifications.
- **A decision, not a fix** — a default, a policy, or wording a user will notice.
- **Large or seam-crossing** — more than one package's logic in one diff.

### The reversibility test (the tie-breaker)

When the trigger list is silent, ask: *if this lands and is wrong, what does undoing it cost?*

- a `git revert`, no data to repair, no user saw it, no external contract → **`AUTO`**.
- a migration back, a data repair, a re-release, or a contract change → **`OWNER`**.

### AUTO is permission, not a shortcut

**Auto-merge is permission for the cheap-to-reverse, no-decision class, and only for it**
(owner decision, 2026-10-17). It is not limited by visuals: a visual diff is cheap to reverse
and auto-merges too, once the before/after packet is posted at the head. For `AUTO` the parent
still posts the evidence comment at the head — then merges without waiting. For `OWNER` nothing
changes: a current-head 5/5 with no unresolved actionable findings, with every check green, is the bar
to *ask* — not permission.

The parent re-checks the class, the triggers and the four reasons **at the current head, every
time**. A push after a verdict voids it, and a diff that was reversible before a push can be
irreversible after it. A `.github/` change is always the owner's, whatever else is true.

The rules for same-PR refinements and finding resolution are defined in [`docs/engineering-workflow.md`](engineering-workflow.md#review-invariants); they do not weaken this gate.

## 4. If it cannot merge now

Queue it with the priority scripts and take it when capacity allows. Do not fudge the gate, and do
not sit idle on it.

```sh
bash .scratch/scripts/crew-queue.sh add <issue> high|normal|low|blocked "one-line reason"
bash .scratch/scripts/crew-queue.sh prio <issue> high|normal|low|blocked   # re-prioritise
bash .scratch/scripts/crew-queue.sh unblock <issue> [priority]             # a blocked item's way OUT
bash .scratch/scripts/crew-queue.sh list
```

**`blocked` is a priority level, not a subcommand.** There is no `block <issue> <blocker>`; an
item is blocked by setting its priority to `blocked` and naming the blocker in the note.

`blocked` is for an issue genuinely waiting on another issue to land, and the blocker must be
named. Admission to a slot is separate and is decided by load through `crew-admit.ts`, which
admits under 80% and sheds over 92%. A full Playwright suite needs an `e2e-slot.sh` lease,
because more than two concurrent runs make the guards flaky.

## 5. Provenance: every agent commit says who made it

Every commit an agent writes ends with a provenance trailer, so a defect can be traced to the
model, the harness and the thinking effort that produced it — and so an effort change can be
tested against real outcomes instead of a feeling:

```
Model: zen-proxy/deepseek-v4.1-flash-free
Thinking: high
Harness: pi
Agent: delegate/269-round7
```

Rules:

- `Model` is the exact provider/model string a harness will accept (the one in the composer's
  catalogue), never a display label.
- `Thinking` is the effort level **in force for that commit**. If it is unknown, write `unknown`;
  never guess.
- `Harness` is `t3-code` or `pi`.
- `Agent` is the role: `parent`, `crew-lane/<issue>-<round>`, `delegate/<short-id>`.
- A human-authored commit carries none of these; their absence means a human wrote it.
- **Squash makes this cheap to lose.** The parent repeats the trailers in the PR body and in the
  evidence comment, so the merge record keeps the provenance after the commit graph is flattened.

The point is the correlation, not the ceremony: when a fix round exists, the trailers say which
model at which effort needed how many rounds, and an effort change can be judged by whether the
next round count drops.

## See also

- `docs/engineering-workflow.md` — the lifecycle this gate sits at the end of.
- `AGENTS.md` — the authority boundary (a lane commits and reports; the parent pushes, opens the
  PR, requests review and merges).
- `.agents/skills/feature-implement/SKILL.md` — steps 11-13, the parent-owned half.
