# #259 — code-review evidence (Standard tier), Standards + Spec

Head reviewed: `6a97cd67db1326b4e7b5d5f88910e1bb9b21afa9` (final). Round 1 at `d9d07cf` and round 2 at
`ab163de`; round-2 minors applied in `6a97cd6`. Lens: an independent read-only `reviewer` child.
Verdict: **no blockers; both axes pass.**

## Standards axis

- The three lane-facing files link to `docs/verification-and-merge-gate.md` and every link target
  resolves (`linksToDoc` asserts this in the guard). The `../../../docs/...` link from
  `.agents/skills/feature-implement/SKILL.md` resolves to the repo root.
- No contradiction with `docs/engineering-workflow.md` or `AGENTS.md`: both still say 5/5 + head
  anchor + green checks is the bar to *ask*, not permission; the new doc repeats it rather than
  loosening it.
- No duplicated rule that disagrees. The four reasons now appear in the doc, `engineering-workflow.md`
  and `AGENTS.md`; they agree. Residual drift risk noted (only the doc's copy is pinned by the guard).
- `feature-implement` is not in `skills-lock.json`, so editing it needs no `.claude` mirror update;
  `bun run skills:check` → in sync, exit 0.

## Spec axis (issue #259 acceptance)

- **(a) discoverable** — met. The rule is referenced from `docs/engineering-workflow.md`, `AGENTS.md`
  and `feature-implement/SKILL.md`, and the guard fails if any link is dropped. The *literal* lane
  launch prompt (`crew-pickup.sh`, `gen-briefs.ts`) is harness-local and untracked; the lane reaches
  the doc through the two tracked files its prompt already tells it to read. Disclosed in the guard's
  own comment and in the design doc.
- **(b) the scripted parts stay scripted** — met. `crew-mergeable.ts --selftest` → 21/21, exit 0;
  it hard-refuses reasons 1-3 plus pending/failed checks and any non-`MERGEABLE` state. The doc states
  plainly that reason 4 is **not** scripted and is the parent's check, which the review verified
  against `decide()`.
- **(c) the evidence form is restated in the lane brief template** — met in the untracked
  `gen-briefs.ts:77-84` trailer, which already carries it. Not changed here; parent-owned file.
  The round-1 finding added the missing *who-posts-the-comment / marker* line to the tracked doc.

## Round-1 Major (fixed)

The doc told a lane to put evidence in the commit body, but reason 4 needs a PR evidence comment and
no step named the poster or the marker. `docs/verification-and-merge-gate.md:39-42` now says it: the
parent posts the comment at the head with `<!-- crew-evidence -->`, and a lane that writes only the
commit body fails reason 4. The review confirmed the marker string matches `crew-mergeable.ts:45`.

## Round-2 minors (fixed in 6a97cd6)

- §2 names an unresolved `UNKNOWN` as well as `CONFLICTING` (the script refuses on any non-`MERGEABLE`).
- §3 AUTO row reads as a summary ("e.g.") rather than the exhaustive inert set.
- §1 says "reason 4 is judged from" instead of "the gate reads".

## Notes for the parent (out of lane scope)

- `crew-pickup.sh:277` / `gen-briefs.ts:77-84` still tell a lane to put evidence in the commit body
  and never mention the PR comment or the marker. If you want the lane prompt to carry the who-posts
  rule, that is a harness-local edit.
- `crew-mergeable.ts:19` header says "The three verdicts" while `Verdict` has four (`MERGED`). Stale
  header in the untracked script.
