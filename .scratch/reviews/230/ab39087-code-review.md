# #230 code-review — STANDARDS + SPEC

Reviewed: `git diff 9d49320...HEAD` at HEAD `ab39087475ab0bbbb8c59e2c2f504cdc39de1586`.
Fixed point: `9d49320` (head of `docs-tier-discipline`, the PR #230 head). Tier: Standard.
Two independent reviewer sub-agents (Standards axis, Spec axis) over the delta that closes the
Greptile finding on `docs/engineering-workflow.md:80-82`.

Post-review delta, committed with this evidence: three em dashes removed from
`.scratch/implementation/230-design.md` (Standards finding below). `.scratch/` is non-reviewable, so
this evidence stays valid at a later HEAD; the reviewable `docs/engineering-workflow.md` content is
untouched.

---

## Standards

**Blocker:** none.

**Correct**
- `docs/engineering-workflow.md:80-83`: the reworded examples now match the table's rule.
  "without risking a named failure" → Standard, and the auth example is gated on "that can bypass a
  session check", which maps to failure mode (4) at line 88 ("a login, session, RBAC or
  secret-handling rule is bypassed"). The path-implies-tier reading is gone, so the example no
  longer contradicts the paragraph at lines 92-97.
- The design doc records tier + justification as the workflow requires
  (`.scratch/implementation/230-design.md:3-8`), same shape as `228-design.md`.
- Sweep claim verified: no path→tier example survives in `feature-implement/SKILL.md:25` or
  `test-audit/SKILL.md:18-20`; both defer to the canonical failure-mode list.

**Judgement calls**
1. `.scratch/implementation/230-design.md` used em dashes, against `.agents/skills/unslop/SKILL.md`
   rule 13 ("Avoid em dashes"). Low severity: the mechanical gate only flags em-dash *chains*, and
   `228-design.md` sets the same precedent.
   **Disposition: fixed.** All three em dashes removed before this evidence commit.
2. Line 81 says "a named failure" where the doc's term of art is "failure mode" (lines 87, 92).
   **Disposition: kept.** This is the Greptile-suggested wording the brief quotes; it reads well and
   the conditional clause carries the meaning.
3. `.scratch/implementation/230-design.md` quotes the edited sentence verbatim (Duplicated Code,
   judgement).
   **Disposition: kept.** Normal for a design doc recording its own change.

## Spec

**(a) Missing/partial requirements** — none.

- "Make both opening examples conditional on whether the change can cause a named failure": both are
  (`docs/engineering-workflow.md:81-83`). The path is no longer the deciding clause.
- Five named failure modes untouched (`:89`).
- Recorded-tier requirement untouched (`:101-103`).
- The two listed follow-ups are not folded in: no tier-consistency guard exists, and
  `guard/SKILL.md` / `debate/SKILL.md` are unmodified.

**(b) Scope creep** — none. Two files: the single finding's fix plus its design doc. No code, tests,
config or `.github/` change.

**(c) Implemented but looks wrong** — none.

**Note:** the area-vs-failure-mode shorthand in `guard/SKILL.md:80` and `debate/SKILL.md:20` names
categories, not paths, so it is outside this finding and is the target of follow-up #2. Correctly
left.

**Verdict:** spec fully met; sweep clean; no other example ties a tier to a path.

---

**Summary — Standards:** 0 hard violations, 1 fixed (em dashes in the design doc), 2 judgement
calls kept. Worst: the em-dash prose tell, now fixed.
**Summary — Spec:** 0 missing requirements, 0 scope creep, 0 wrong implementations. Worst: none.
