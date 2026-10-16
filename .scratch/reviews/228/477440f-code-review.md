# #228 code-review — STANDARDS + SPEC

Reviewed: `git diff a52084d...HEAD` at HEAD `477440f27533d465b7e55a96d11db43723f172cb`.
Base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (merge-base with `origin/develop`).
Tier: Standard. Two independent reviewer sub-agents (Standards axis, Spec axis), round 2
after the first pass's findings were fixed.

---

## Standards

**Blocker:** none. No hard violation of a documented standard found in the diff.

**Correct**
- `test-audit/SKILL.md:18-20` is the "point, don't restate" shape: names the tier set, then
  delegates escalation to the canonical section and says so. The contradiction with
  `feature-implement` §7 and the lifecycle diagram is genuinely resolved (grep confirms no other
  in-scope file says test-audit is High-assurance-only).
- `docs/engineering-workflow.md` High-assurance row encodes five failure modes, not a path or a
  diff size; the diff-size contrast (600-line screen vs 12-line `auth/**`) is concrete and
  active-voiced. This satisfies the brief's central ask.
- Unslop on the new prose: no em-dash chains, no rule-of-three, no puffery, no invented
  vocabulary, headings stay sentence case. The design doc writes with opinions.
- `.scratch/implementation/228-design.md` is tracked by repo convention (many siblings in
  `git ls-files`; `.gitignore` does not ignore that path), so committing it is not
  source-only-policy drift.

**Notes (judgement calls)**
1. `engineering-workflow.md`, paragraph after the table: "Dokan examples that exercise these
   modes: stock quantity…, average-cost recomputation, payment amounts exceeding invoice totals,
   debt direction…, auth login" restates table items 1-4. Duplicated Code, same meaning twice.
   **Disposition: kept on purpose.** The brief says "The existing examples list must be kept."
   Removing it would fail the spec.
2. `feature-implement/SKILL.md:21-25`: only the High-assurance row points at the canon; the
   Standard and Lightweight rows are copied and can drift. **Disposition: accepted.** The brief
   says "keep" the §1 table and only requires the High-assurance row to point at the failure
   modes. A full pointer replacement is a follow-up, not this change.
3. Middle-column header "Decision: what the change can break" holds for High-assurance; Standard
   is a file-kind taxonomy and Lightweight is a path list. Internal tension, low severity.
   **Disposition: accepted.** The escalation rule (High-assurance) is the one that must be a
   failure mode; the other two tiers are defined by what they touch.
4. `schema-version bump` and `security` survive only as "examples that hint at a failure mode"
   with no mode named, so a schema bump could now fall to Standard. **Disposition: documented
   risk, deferred.** The brief redefines High-assurance strictly as the five failure modes; a
   schema bump that risks data is mode 5 and a reader maps it there. Preserving a generic
   schema-bump trigger would re-introduce the "feeling" rule the issue removes.
5. Residual drift is wider than the design doc says: `guard/SKILL.md:71-80` and
   `debate/SKILL.md:20` still restate High-assurance criteria. **Disposition: out of scope,
   reported in crew_report with a proposed follow-up.**
6. Milder unslop tells: negation-heavy steering, three bolded clauses in one short section,
   colon-as-connector in the Lightweight cell. Low severity, no fix.

## Spec

**(a) Missing/partial requirements** — none critical.

- Spec: "the diff can violate one of these NAMED failure modes" — the doc enumerates all five
  verbatim in the table's decision column (`docs/engineering-workflow.md:85`).
- Spec: "docs/engineering-workflow.md becomes the single source of truth" — **partial**.
  `.agents/skills/guard/SKILL.md:80` still restates the rule. Guard is outside the three-file
  scope and the spec's "do not change" list does not name it, so leaving it is compliant with the
  letter of the spec, but the goal is not fully reached. The design doc pre-declares this as
  residual drift, so it is a known, documented gap. Note only.
- Spec: "the lane records the chosen tier and a one-line justification in its design doc" —
  present in `docs/engineering-workflow.md` and in `feature-implement` §1/§2.

**(b) Scope creep** — none against the spec. No `.github/` or `docs/ci.md` change. Sub-agent
counts unchanged (test-audit still launches 3; §7 wording untouched). Hygiene observation:
`.scratch/implementation/228-design.md` is committed; `.gitignore:39` ignores only
`.scratch/sessions/`, and the workflow requires the design doc, so the file is legitimate.

**(c) Implemented but looks wrong** — none. The forbidden phrase "`store/**` is High-assurance"
is explicitly negated (`docs/engineering-workflow.md:92`), and `apps/api/src/auth/**` and
`store/**` are labelled non-tests. The existing examples list is kept and labelled.

**Verdict:** spec fully met for the three in-scope files; two notes (guard restatement, committed
scratch doc).

---

**Summary — Standards:** 0 hard violations, 6 judgement notes (2 kept on purpose, 1 accepted, 1
deferred, 1 out of scope, 1 cosmetic). Worst: residual restatement in `guard/SKILL.md`.
**Summary — Spec:** 0 missing requirements, 1 partial (same `guard/SKILL.md` restatement, out of
scope), 0 scope creep. Worst: the partial single-source-of-truth claim.
