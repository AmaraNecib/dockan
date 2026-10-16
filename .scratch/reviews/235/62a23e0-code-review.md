# #235 code-review — STANDARDS + SPEC

Reviewed: `git range` — `git diff c3f854450f8492fb534ea3dfa8859c0b5c8353d6...HEAD` at HEAD
`62a23e0256b88f9321a70050fd57cdd7978aebce` (branch `docs-authority-and-wisdom`, 3 commits:
`c63ea58`, `e3e94c7`, `62a23e0`).
Base: `c3f8544` (merge-base with `origin/develop`). Tier: **Standard**.
Reviewers: independent sub-agents, **Standards** and **Spec** axes run separately in round 1, and
again in a closing verification round over the full range diff (not just the fix commits). No
reviewer wrote a file.

---

## Standards

**Blocker:** none.

**Correct, with evidence**

- Scope: `git diff --name-only` returns exactly the six declared files. Nothing under `.github/`,
  `apps/`, or `packages/`. Docs and skills only, as the brief requires.
- No restructure: every hunk is wording/attribution on existing structure; no section moved or
  reordered.
- The **#230 review-tier section is untouched** (`docs/engineering-workflow.md` hunks land at the
  lifecycle diagram, the Tickets/specs wisdom bullet and Merge rules; the Review tiers block has no
  hunk).
- Mirror consistency verified from `skills-lock.json` itself: 32 lock keys, 32 `.claude/skills`
  directories, set difference empty both ways; the four edited skills are absent from both.
- Unslop: no em-dash *chains* (the §11 chain found in round 1 was split); no puffery, hedging, or
  forced rule-of-three; sentence-case headings; straight quotes.
- The rule is stated once per consumer document and never contradicted across the changed set.

**Findings** (all fixed)

| # | Finding | Rating |
|---|---------|--------|
| F2 | `feature-implement` `## Merge rules` unfenced `gh pr merge`, actor "the agent" | 🟠 |
| F3 | `feature-implement` frontmatter listed capture-wisdom as a lane delegate | 🟠 |
| F7 | `capture-wisdom` description contradicted its own read rule | 🟠 |
| N1 | Routing row "Greptile not clean" not marked parent-only | 🟠 |
| N2-N7 | Actorless Greptile bullets; weak `AGENTS.md` Merging wording; step-10 cross-reference; unlabelled merge command; lesson-field phrasing; `debate` "before push" | 🟡 |

## Spec

**Blocker:** none. All five numbered changes and the owner's mid-lane scope addition are present and
verified against the diff: `AGENTS.md:3-26` (Authority), `docs/engineering-workflow.md:29-64, 117-127,
145-154` (lifecycle, wisdom rule + side effect, merge attribution), `feature-implement:148-218`
(§10 retitle + parent-only fence, §11 attribution, §12 no lane wisdom step, Merge rules),
`capture-wisdom:1-30` (parent-only write + repeated-pattern criterion in body and frontmatter),
and the mirror no-op.

**Generated children for the spec-verification checks** (both asked for in the brief):

```
$ grep -rn "git push"     .agents/skills/ docs/engineering-workflow.md
.agents/skills/feature-implement/SKILL.md:161:git push origin <branch-name>
$ grep -rn "gh pr create" .agents/skills/ docs/engineering-workflow.md
.agents/skills/feature-implement/SKILL.md:162:gh pr create --base develop \
```

Both occur exactly once, inside the block under `**Parent-only — a lane must not run these:**`
(`feature-implement:159-165`). `gh pr merge` is under `**Parent-only command:**` (`:216-218`) and
`Parent-only merge command:` (`docs/engineering-workflow.md:154`). **Gate: PASS.**

**§10 and §12 read end to end as a lane:** the conclusion is *commit, `crew_report`, stop* — a lane
would not push, open a PR, merge or write `.agents/wisdom/`.

---

## Residual notes for the parent (all 🟡, none actionable here)

1. `docs/engineering-workflow.md:143` retains "**The agent** never merges on its own initiative" —
   the ambiguous noun that was removed from `AGENTS.md:72`. The next sentence disambiguates it, and
   the brief said to keep the merge text intact apart from attribution. One revision behind its twin.
2. `docs/engineering-workflow.md:94` (the Review-tiers routing row) lists `Greptile` and guard 3 with
   no actor. Inside the #230 section the brief forbids touching.
3. `capture-wisdom:13` cites "(the numbers are in `AGENTS.md`, Authority)", but `AGENTS.md` carries
   the collision counts only; the "two lanes declined … evidence stale" motive is not repeated there.
4. `capture-wisdom:18-22` restates the "twice/recurred" criterion in each bullet and uses second
   person in a now-parent-only doc.
5. `guard:40-42` still says "the gate before Greptile review and before any push" — true, since only
   the parent pushes, but the actor is unnamed.
6. `.agents/skills/feature-implement/SOURCE.md:6` (a vendoring provenance note) still lists
   capture-wisdom as a delegate. Outside the rulebook; left untouched to keep the vendoring note
   faithful to its upstream.
7. The forbidden-command list (`AGENTS.md:7-8`) is the brief's exact set: push, `gh pr create`,
   merge. `gh pr edit` / `gh pr review` and a forced push are not named.
8. `docs/ci.md:200` contains `git push origin v0.2.0` (release tagging). A maintainer release
   procedure, not a lane instruction; outside the brief's grep scope.
9. The `crew_report` `lesson` field is written into the docs per the owner's instruction. This
   session's tool schema does not list it (`additionalProperties: false`), so the fallback clause is
   load-bearing until the schema ships the field.

**Verdict:** ship — all brief changes and the scope addition are present, the grep gate passes, a
lane reading §10/§12 would not push, and no 🔴/🟠 finding remains open.
