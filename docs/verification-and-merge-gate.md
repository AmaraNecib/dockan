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
changes: a 5/5 with no findings, anchored to the current head, with every check green, is the bar
to *ask* — not permission.

The parent re-checks the class, the triggers and the four reasons **at the current head, every
time**. A push after a verdict voids it, and a diff that was reversible before a push can be
irreversible after it. A `.github/` change is always the owner's, whatever else is true.

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
Model: opencode-go/deepseek-v4.1-flash
Thinking: high
Harness: t3-code
Agent: crew-lane/269-round7
```

Rules:

- `Model` is the exact provider/model string a harness will accept (the one in the composer's
  catalogue), never a display label.
- `Thinking` is the effort level **in force for that commit**. If it is unknown, write `unknown`;
  never guess.
- `Harness` is `t3-code`, `pi-cli`, or `herdr`.
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
