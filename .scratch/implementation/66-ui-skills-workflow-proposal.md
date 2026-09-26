# Proposal: required UI skills, decided by file and proved by review

Status: proposal. Nothing here runs today. This document adds no gate script, no CI job, and changes no skill's semantics.

Issue #66 (`wayfinder:map`). Base: `develop` at `2611953`. Written 2026-09-26.

## What #66 asks

When a PR touches the UI seam, the right UI skills should be required, with evidence they were used. Two halves: decide which files need which skills, and enforce that the skills were used. This document settles the decide half and proposes where enforcement would live. It does not build enforcement.

## What exists today

`feature-implement` step 5 has a table that says "if the change touches X, load these skills". That is advice to the lane. Nothing checks it, and nothing connects a changed file to a skill. `guard` Phase 2 already checks that review evidence exists and matches HEAD. So the repo has a place to hang a UI-skills check and an evidence-file convention to reuse.

## 1. File seam to skill matrix

### Which paths count

A change is in the UI seam when it touches any of:

- `apps/web/src/pages/**`
- `apps/web/src/components/**`
- `apps/web/src/index.css`
- `apps/web/index.html`

Everything else (hooks, lib, api, tests, desktop rust) is out of this matrix.

There is a deliberate gap. `apps/web/src/lib/i18n.ts`, RTL direction, and Arabic copy are not covered by a locked skill today. `impeccable` holds `clarify` and `typeset`, but it is pinned at v3.9.1 (see below), so it cannot be required yet. Until that changes, copy and RTL edits map to `accessibility` only, which is weaker than they deserve.

### Threshold

The globs decide where to look. The threshold decides whether a change is significant enough to require skills.

A change is significant when any of these hold:

1. It adds a file under the seam globs.
2. Changed lines (added plus deleted) inside the seam globs is 40 or more.
3. It edits `apps/web/src/components/ui/**` at all. Those are shadcn primitives; a one-line change there can change every consumer.
4. It adds or edits `role=`, `aria-`, `tabIndex`, `onKeyDown`, `onFocus`, `autoFocus`, a `<dialog>`, or a form control. Accessibility has no line threshold.

A change is exempt when 1 to 4 are all false. The clear case is a label, date-format, or copy edit in an existing page that adds no structure, no props, and no interactive elements. A tab rename should not drag `frontend-design` and `web-design-guidelines` into the lane.

I picked 40 because a real layout change usually clears it and a text edit usually does not. It is a starting number, not a law. Tune it after the first ten UI PRs.

### Matrix

| Changed path or marker | Required skills |
|---|---|
| New page or route under `pages/**` | `frontend-design`, `web-design-guidelines` |
| Significant edit to `pages/**` or `components/**` | `frontend-design`, `web-design-guidelines` |
| `components/ui/**` touched, or a new shadcn component added | `shadcn` |
| Component gains props, variants, or compound parts | `vercel-composition-patterns` |
| `role=`, `aria-`, keyboard, focus, dialog, table, or form control | `accessibility` |
| Styling or token change (`index.css`, theme) | `web-design-guidelines` |
| New UI flow with a user path | `playwright-best-practices` (test design, not visual) |
| Desktop shell UI (`apps/desktop/src-tauri/**` window, tray, menu) | `tauri-v2` |

Rows stack. A new page with a dialog requires `frontend-design`, `web-design-guidelines`, `shadcn` if it uses a primitive, and `accessibility`.

`redesign-existing-projects` is deliberately absent. It is for upgrading a surface to premium quality, which is a task the owner asks for, not a condition a diff implies.

## 2. Where the check runs

Three options.

**A. A pre-push guard script (`check:ui-skills`).** Deterministic and blocking. But it sees only committed text, and it cannot tell whether a lane read a skill. It would gate on a header being present, which is the weakest part of the idea. It also adds friction to every UI PR before review, including ones that need no design skill.

**B. A review-lane instruction.** Add it to `feature-implement` step 5 and the `guard` Phase 2 checklist. Cheap, no code. But it is diligence again, which is the thing #66 says does not work.

**C. Hybrid, and my recommendation.** A small reporter script that prints the required skill set for the pinned diff, run in Guard Phase 2 and copied into the lane report. It does not gate. The gate is a `## Skills applied` section in the code-review evidence that a fresh-context reviewer checks. This reuses the evidence-file discipline `guard` already enforces.

I would not build option A. A script that parses a header proves a string exists, not that anyone read a skill. Keep the mechanical part to deciding the set, and put the proof where a fresh context can judge it.

## 3. What the reporter parses

The git diff against the pinned merge-base, not the lane's changed-file list.

`git diff --name-only "$(git merge-base origin/develop HEAD)...HEAD"` plus `--numstat` for line counts. This is the same base the review evidence is keyed to, so the required set and the evidence SHA agree by construction. The lane report's file list is a derived copy that can be stale or trimmed by hand.

Run it at Guard Phase 2, when the branch is committed. For uncommitted work, Phase 1 can run `git diff --name-only HEAD` as an advisory preview, but the contract applies to the committed diff.

## 4. Is the reviewer cross-check mandatory per tier?

Mandatory whenever the matrix produces a non-empty required set, on every tier that can produce one. In practice that is Standard and High-assurance, because Lightweight is limited to `.gitignore`, `LICENSE`, and `.scratch/` and can never fire the matrix. High-assurance adds `debate` on top. There is no Standard-tier opt-out below the exemption threshold, because the exemption already covers the small diffs. Past the threshold, the point is that lane diligence is not enough, so a tier-based opt-out would reopen the hole.

## 5. Evidence contract

The code-review evidence file `.scratch/reviews/<issue-id>/<sha>-code-review.md` carries:

```
## Skills applied
- frontend-design: <one rule from the skill, and where in the diff it shows>
- accessibility: <one rule, and where>
```

One line per required skill. Guard Phase 2 checks the section exists and the SHA is current. The reviewer checks the lines are true.

## The honest limit

A lane can write that header without opening the skill. The text is cheap. The only real check is the fresh-context reviewer re-loading the named skills and judging the code against them. That reviewer must be able to say "the header claims `accessibility` but the dialog has no focus trap and no accessible name", and that finding must block. If the reviewer only checks that the section exists, the whole thing becomes name-dropping with paperwork. The reviewer instruction is the load-bearing part, not the header format.

## impeccable is pinned at v3.9.1

`.agents/skills/impeccable` is not in `skills-lock.json`. It ships through its own channel, `npx impeccable update`. On 2026-09-26 that channel is broken upstream:

```
$ npx impeccable update --project --yes
Updating the this project install: D:\projects\mani-project\worktrees\ui-skills (.agents)
Checking for updates...
Download failed: Could not verify skill bundle: HTTP 404. Nothing was installed; retry or update the CLI. If this persists, report it at https://github.com/pbakaus/impeccable/issues/479
exit 1
```

`npx impeccable check` returns the same 404. The CLI itself is `4.1.0` (`npx impeccable --version`), and `impeccable@3.9.1` is not published on npm (npm returns `ETARGET`), so the CLI version is not a way to pin the skill. The installed skill stays at v3.9.1 until pbakaus/impeccable#479 is fixed.

Consequence for this proposal: keep `impeccable` out of the required set. A required skill that cannot be refreshed is a liability, and its sub-commands (`clarify`, `typeset`, `layout`) are not separately locked. Retry the update when the issue closes, then record the new version in `.agents/skills/impeccable/SOURCE.md`.

## Open questions for sign-off

1. Threshold 40 lines and the marker list: accept, or pick a different number?
2. Matrix rows: anything missing, especially RTL and Arabic copy, which no locked skill covers today?
3. Reporter script: build it later as advisory, or stay manual for now?
4. High-assurance: should the UI cross-check run before or after `debate`?

## Graduation path

This is a proposal, so it lives in `.scratch/implementation/` per the repo's design-doc convention, not in `docs/`. `docs/adr/` records accepted decisions, and this is not one yet.

Once the thresholds and the enforcement point survive a few real PRs, graduate it: add a "UI skills gate" section to `docs/engineering-workflow.md`, and if it becomes a standing rule, write a short `docs/adr/` entry. Link both from the #66 map's Decisions-so-far. Until then, treat nothing here as binding.
