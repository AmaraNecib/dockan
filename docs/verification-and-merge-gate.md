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
| **not visual** — logic, a feature, a refactor, a fix | the **measurements**. Not "it works": the failing-first run (red before, green after), the ablation/mutation proof that the new guard actually bites, the before/after numbers, and the decisions taken and why. |

An **inert** diff (§3) cannot reach the product, so its measurement is the CI run itself — still posted as the evidence comment reason 4 requires. The form changes; the obligation does not.

The non-visual bar is the owner's own phrasing: *"You want evidence that it was right for you
as the agent."* The parent has to be able to judge the change from the comment alone, without
re-running it. A green check is not evidence that the right thing was built; it is evidence
that something ran.

### Visual evidence, in its exact form

A clip at the real user pace, 30–45 s. Record it headless as webm, convert to mp4 or gif, and
upload it to the public `crew-evidence` bucket under `<project>/<pr>/<artifact>`. GitHub renders
images and GIFs inline but never video, so a linked mp4 is the wrong shape for a PR comment;
the GIF or the inline frame is what the parent actually sees and judges.

### What counts as failing-first

A test that never failed proves nothing. The evidence must show the artefact **red before the
change and green after it**, with the failing assertion named. A guard added without a case that
reddens when the guard is deleted is not a guard. Run the guard's mutation against the current
head; an inherited mutation table is an unrun gate.

Put the evidence in the commit message body so the parent can reuse it for the PR description, and keep
the lane's working notes in `.scratch/reviews/<issue>/<sha>-<gate>.md`. The **PR comment is what reason
4 is judged from**: the parent posts it at the head, with the `<!-- crew-evidence -->` marker in the body. A
lane that only writes the commit body produces no comment, so reason 4 fails at merge.

## 2. The four reasons

A pull request may be merged when **all four** hold. Not three. Any one missing sends it back to
the queue or back to a lane.

1. **Greptile confidence is 5/5.** Not 3, not 4. A 3/5 naming two "silent escapes" is a refusal,
   not a note.
2. **`Last reviewed commit` equals the current head SHA.** A verdict anchored to an older commit
   says nothing about the code being merged. A rebase or a fix invalidates the previous verdict —
   re-request the review.
3. **No comment lands after the verdict, except pinned evidence.** The one exemption is a comment
   carrying the `<!-- crew-evidence -->` marker: evidence is supposed to arrive after the review,
   and the marker is how the gate tells it apart from a new finding. Any other comment after the
   verdict means the PR is not settled.
4. **An evidence comment is present**, in the form section 1 requires for that change — and the
   evidence must be **at the head being merged**, not at some earlier commit.

On top of the four: **every CI check is green or legitimately skipped** (a correctly gated job
reporting `skipped` is fine; a `pending`, or `pending`-then-cancelled, check is not), and the PR
is **not** `CONFLICTING`.

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

The class that decides **who merges** is **visual or not**, not inert or not. A diff the eye can
judge is the owner's; everything else the parent may land itself once the gate is clean.

| the class | who decides | who reads the diff |
| --- | --- | --- |
| **VISUAL — anything a browser can render: `apps/web/**`, i18n/copy, CSS/tokens, image assets, or any diff the predicate marks `needsVisual`** | `OWNER` — the owner verifies the before/after packet at the head and says merge. | the owner |
| **NON-VISUAL — everything the predicate does not mark `needsVisual`, including inert diffs (tests, `*.md`, docs, `.agents/`, `.scratch/`, fixtures)** | `AUTO` — the **parent is pre-authorised to merge it itself** when reasons 1-4 hold, every check is green or legitimately skipped, and GitHub reports `MERGEABLE`. | the predicate; no human reads it |
| **anything under `.github/`** | `OWNER` — a CI change always goes to the owner for the diff, whatever the class. | the owner |
| **a wrong fact anywhere in the gate** | `REFUSED` — not a judgement call. Fix the fact, or the finding, and re-review. |

A PR GitHub already reports `MERGED` is a fourth outcome, `MERGED`: a different question, not a
decision, and the predicate reports it rather than answering the merge question. `scripts/**` that is
not a test is deliberately code, not inert: a script can drive CI or a release, and guessing otherwise
would be the wrong direction of error.

**Auto-merge is permission for the non-visual class, and only for it** (owner decision, 2026-10-17,
class A). For `AUTO` the parent still posts the evidence comment at the head — then merges without
waiting. For `OWNER` nothing changes: a 5/5 with no findings, anchored to the current head, with
every check green, is the bar to *ask* — not permission.

The parent re-checks the class and the four reasons **at the current head, every time**. A push
after a verdict voids it, and a PR that was non-visual before a push can be visual after it.

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

## See also

- `docs/engineering-workflow.md` — the lifecycle this gate sits at the end of.
- `AGENTS.md` — the authority boundary (a lane commits and reports; the parent pushes, opens the
  PR, requests review and merges).
- `.agents/skills/feature-implement/SKILL.md` — steps 11-13, the parent-owned half.
