# e3094de — Standards axis

Scope: `git diff da5f336...e3094de` + `git show e3094de` (3 hunks, 2 spec files). Read-only git/grep/sed;
**no tests, typecheck, lint or playwright were run** (the commit's own logs were read as text only).
Standards sources: `docs/engineering-workflow.md`, `AGENTS.md`, `docs/verification-and-merge-gate.md`;
Fowler names below are judgement calls, not rule breaches.

## (a) Documented-standard breaches

1. **Evidence filenames carry no SHA — `docs/engineering-workflow.md:145-146`** ("Review evidence lives in
   `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md`. Evidence filenames must contain the exact reviewed
   HEAD SHA; any later reviewable-file change makes evidence stale"). The commit body points at
   `pre-fix-e2e-red.log`, `pre-commit-e2e-green.log`, `typecheck.log`, `lint.log`, `ablation-A1/A2.log`;
   `ls .scratch/reviews/257/` confirms none contains `e3094de`, and they are `.log`, not `<sha>-<gate>.md`.
   Consequence the rule exists to prevent: a later reviewable-file change cannot be seen to make them stale.
   (`e3094de-test-audit.md` is the only file that follows the pattern.) No blocker on the assertions themselves.

Nothing else in the diff breaches a written rule. The diff is inert (§3), the tier is recorded
(`.scratch/implementation/257-round3-design.md:3` "**Tier:** standard."), and §1's non-visual bar is met in
form: failing-first with the assertion named, green with counts, 2/2 ablations, decisions listed.

## (b) Baseline smells (judgement)

- **Duplicated Code** — `await expect(page.getByTestId("purchase-saved-number")).toContainText(/SUP-\d+/);`
  now appears at `purchase-inline-product.spec.ts:97` and `:185`, with a third copy of the same shape in
  `supplier-adjustment.spec.ts:102` (`match(/SUP-\d+/)`). The suite already exports helpers
  (`rpc-helpers.ts`, `items-helpers.ts`), so a shared `expectSavedNumber(page, "SUP")` has an obvious home.
- **Divergent Change** — sibling purchase specs pin the number as `toContainText("SUP-")` + an innerText
  `.match(/SUP-\d+/)` (`purchase-intake.spec.ts:93,99`; `96-returns-supplier-action.spec.ts:80,82`;
  `supplier-adjustment.spec.ts:100-102`). This diff pins it with a `toContainText(/regex/)` instead: same
  knowledge, two idioms, chosen per file.
- **Shotgun Surgery** (secondary) — that knowledge is copied across ~6 specs, so a prefix change is an N-file edit.
- **Mysterious Name** (weak) — `supplier-adjustment.spec.ts:101` now says "purchase numbers" above an
  unchanged `const invoiceNumber`.
- Note: comment at `:94-96` explains history (#268), not the contract; the sibling specs state the contract
  ("the saved card always formats purchase numbers as SUP-<digits>") in one line.
