# Code review — issue #96 round 4

Head reviewed: `b436c68` (both agents read `777f3f7`; see *Provenance*).
Fixed point: `5144100` (`git diff 5144100...HEAD`).

Two axes ran as parallel sub-agents and are reported separately, per the skill.

## Standards

> **Standards sources checked:** AGENTS.md, docs/engineering-workflow.md, docs/
> (no `CODING_STANDARDS.md`/`CONTRIBUTING.md` exists; `docs/*.md` are
> workflow/ADR/CI), oxlint.config.ts (anti-slop + shadcn rules),
> `.agents/skills/{code-review,test-audit,accessibility,frontend-design}/SKILL.md`.
>
> **Hard violations (documented standard): none.** oxlint's anti-slop/shadcn
> rules do not fire on this diff. engineering-workflow's only binding clauses
> here are process (evidence file, tier recorded) — the design doc records
> Standard with justification.
>
> **Judgement calls (baseline smells):**
>
> 1. **Duplicated Code — `lastFilterRef` vs `lastHistoryFilterRef`.** Same idea,
>    different shapes: `invoices.tsx:34` is `useRef<"kind"|"status"|null>`;
>    `expenses.tsx:87` is `useRef<string|null>` carrying a testid. *Justified
>    divergence in the value domain*: invoices has two fixed controls, expenses
>    has N dynamic pills, so a name union cannot express the target. *Not
>    justified in the mechanism*: both repeat read ref → `document.querySelector`
>    → `?.focus()`. Extract one helper.
> 2. **Duplicated Code — test helper.** `focusedTestId` copied verbatim, comments
>    included, into both spec files.
> 3. **Primitive Obsession — testid string in a ref.** Rendering concerns leaking
>    into logic; rename a testid and focus silently drops. The design doc records
>    the risk and the tests cover it.
>
> **Consistent / correct:** resetting the ref to `null` after use; `filteredEmpty`
> mirrors the existing `listFails` fixture pattern; both new tests pre-focus the
> action button so the assertion cannot pass on inherited focus.
>
> **Worst in axis:** the duplicated focus-handoff mechanism (judgement call, no
> blocker).

## Spec

> **Delivered.** Finding 1 fixed — focus is handed to a surviving control *before*
> the state updates. Finding 2 **not** reworked: `invoices.tsx` is untouched by
> the source changes. The other-empty-action sweep is in the design doc. The
> select-driving path is stated in the design doc and the commit body. The
> invoice test drives kind→SALE then status→PARTIAL, which is the only ordering
> that separates the old rule from "focus last changed".
>
> **Missing / partial.** "Failing-first for each test … show the failure" — the
> commit body points at `.scratch/reviews/96-round4/`, which did not exist yet at
> review time.
>
> **Scope creep.** The brief asks for two tests; the diff adds four (1 invoice +
> 3 expenses), and `expenses.test.tsx` gains a `filteredEmpty` branch in the
> shared list mock.
>
> **Implemented but looks wrong.** `toggleCategory` records the pill on *deselect*
> too; `applyBoundEdit` records an unapplied edit. Judgement: making the preset a
> fallback rather than the rule is a **faithful reading** of "apply the same
> reasoning", not a deviation — the operative clause is the invoice rule.

## Dispositions

| Finding | Disposition |
| --- | --- |
| Failing-first artifact missing | **Fixed.** `.scratch/reviews/96-round4/b436c68-failing-first.md` plus the raw red/green outputs; the red run is against the two pre-fix page files. |
| Scope creep: 4 tests instead of 2 | **Accepted and justified.** The brief's acceptance is "two tests that genuinely discriminate"; the extra three cover the branches of the focus rule the fix introduces (last-changed pill, range preset, all-categories pill, missing pill/fallback), each red pre-fix. The `filteredEmpty` mock flag is the smallest way to express "the filtered read is empty while the default window has rows", which is the brief's own scenario. |
| Duplicated focus-handoff mechanism (Standards 1) | **Deferred, not silently.** Extracting a shared `focusByTestId` helper would touch `invoices.tsx`, the page the brief says not to rework; recorded here as a follow-up candidate for the parent to raise as its own issue. |
| `focusedTestId` duplicated (Standards 2) | **Fixed.** One definition in `tests/page-harness.tsx`. |
| Testid-as-primitive (Standards 3) | **Accepted.** The ref holds a `data-testid` because the target is one of N dynamic pills; the tests assert the resulting focus, so a rename fails a test rather than rotting silently. |
| `toggleCategory` records on deselect | **Dismissed.** The rule is "the filter the owner last *changed*", not "the filter that still narrows"; the deselected pill is exactly the control the owner last touched, and it is still rendered. The invoice rule at `5144100` makes the same choice. |
| `applyBoundEdit` records an unapplied edit | **Fixed.** The ref assignment moved inside the applied-bound branch. |
| Preset as fallback vs. "the natural one" | **Kept.** The brief's operative instruction is "apply the same reasoning" as the invoice fix; always focusing the preset after a category filter is the very finding Greptile raised on invoices. The preset is the fallback and is still the target whenever the range is what emptied the view (test "falls back to the range preset when the window emptied the view"). Flagged for the spec author: if they want the preset unconditionally, this is the one line to change. |

## Provenance

Both agents reviewed `777f3f7`. Since then: the harness helper moved, the two
select-driving paths were unified, the state-premise assertion was added, and
both expenses/`applyBoundEdit` code comments and branch were adjusted. Re-ran on
the final head `b436c68`: lint clean, typecheck 4/4, `apps/web` suite
**1197 pass / 0 fail**, and the failing-first pairs. The post-review edits were
not re-reviewed by an agent; the parent's Greptile round covers them.
