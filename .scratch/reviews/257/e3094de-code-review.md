# Code review — #257 review round 3 (PR #266)

- **Reviewed head:** `e3094de` (fix) · **Fixed point:** `da5f336` (the merge of
  `origin/develop` into the PR branch) · `git diff da5f336...e3094de` = 2 files,
  3 hunks.
- **Tier:** standard (`.scratch/implementation/257-round3-design.md`).
- **Spec:** `D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-257-inline-product-round3.md`.
- **Runners:** two independent `reviewer` sub-agents, one per axis, read-only.
  **Disclosure:** both ran no test, typecheck, lint or Playwright command and
  said so; every gate claim below was reproduced in-lane by this session.

## Standards axis — verbatim (`.scratch/reviews/257/e3094de-standards.md`)

Documented-standard breach:

1. **Evidence filenames carry no SHA — `docs/engineering-workflow.md:145-146`**:
   the commit body pointed at `pre-fix-e2e-red.log`, `pre-commit-e2e-green.log`,
   `typecheck.log`, `lint.log`, `ablation-A1/A2.log` — none contained the
   reviewed SHA. **Acted on:** every log is now `<sha>-<gate>.log`
   (`da5f336-pre-fix-e2e-red.log` — the red run predates the fix, so it carries
   the pre-fix SHA; the rest carry `e3094de`), and this file plus
   `e3094de-evidence.md` follow `<head-sha>-<gate>.md`.

Baseline smells (judgement calls, none acted on):

- **Duplicated Code** — the `SUP-` shape now appears at
  `purchase-inline-product.spec.ts:97`, `:185` and (as an innerText match)
  `supplier-adjustment.spec.ts:102`. **Not acted on:** extracting an
  `expectSavedNumber(page, "SUP")` helper would rewrite three sibling specs
  #268 just touched, which is churn outside this lane's two-assertion fix.
- **Divergent Change** — sibling specs pin the number as
  `toContainText("SUP-")` + an innerText `.match(/SUP-\d+/)`, this diff pins it
  with `toContainText(/regex/)`. **Not acted on**, same reason; the regex form is
  the stronger of the two and the brief asks for the shape, not a refactor.
- **Mysterious Name** (weak) — `const invoiceNumber` under a comment that now
  says "purchase numbers". The name predates this diff and is not wrong (a
  purchase *is* an invoice). Not acted on.
- **Shotgun Surgery** (secondary) — the prefix knowledge is copied across ~6
  specs. Pre-existing; a shared helper is a follow-up, not this fix.

## Spec axis — verbatim (`.scratch/reviews/257/e3094de-spec.md`)

Correct, each acceptance criterion against the merged code:

- (4) tree carries #268 (`bbdd005` is an ancestor of `da5f336` and `e3094de`);
- (1) prefix matches the code — `document-number.ts:12-13` maps
  `SALE: "INV"`, `PURCHASE: "SUP"` under
  `satisfies Record<InvoiceKind, string>`; `router.ts:1324` calls
  `allocateInvoiceNumber("PURCHASE")`; `drizzle-store.ts:1848` takes the prefix
  from `invoiceNumberPrefixFor(kind)`;
- (2) meaningful (`/SUP-\d+/`, not "some text");
- (5) ablations bite (prefix stripped → `0001`; `PURCHASE`→`INV` → `INV-0001`);
- (6) green with counts (`18 passed (3.7m)`), red-first with counts
  (`2 failed`, received `SUP-0001`/`SUP-0002`);
- (3) the sweep holds — every remaining `INV-` line is a sale path; supplier
  returns mint `PRT-` in SQL (`drizzle-store.ts:2192`), untouched by #268; no
  purchase or return assertion breaks.

Missing/partial: none blocking.

Scope creep: the `supplier-adjustment.spec.ts:101` comment reword — accepted,
justified by the brief's step 3 and touched by no assertion.

Implemented but inaccurate: **the design doc's sweep counts were wrong** (it said
"33 hits, 31 sale-path", self-contradictory). **Acted on:** the design doc now
carries the measured figures (pre-fix `da5f336`: 36 lines = 30 non-comment + 6
comments, of which 3 purchase-path; post-fix `e3094de`: 34) and the corrected
line citations (`document-number.ts:12-13`, `purchase-intake.spec.ts:93,:99`,
`supplier-account.spec.ts:52,:54`).

## Test audit — verbatim (`.scratch/reviews/257/e3094de-test-audit.md`)

Grade **A-**. Verdict: "the fix is correct and the assertion is non-vacuous. No
blocker."

| Finding | Lens | Risk | Disposition |
|---|---|---|---|
| Customer-return `RET-` shape has no e2e assertion | edge | orange | **Refuted with line evidence.** `completion-screens.spec.ts:58,71` and `returns.spec.ts:86,207` assert `/RET-\d+/` on `returns-done-number` / `returns-row`. The finding was read-only and wrong; no action. |
| `>9999` → `SUP-10001` shape unasserted in e2e | edge | yellow | Acceptable — the regex matches it; unit-pinned (`drizzle-store.test.ts:1593`). |
| Legacy `INV-` purchase row display | edge | yellow | Acceptable — UI-unreachable; `documentNumberSequence` handles ordering. |
| Purchase `SUP-` asserted in 4 specs | coverage | yellow | Acceptable — harmless redundancy, shape assertions. |
| Setup duplication in the two tests | quality | yellow | Acceptable — idiomatic e2e (the file's existing pattern). |

## In-lane re-runs behind this review

- `bun run typecheck` → exit 0 (4/4 turbo tasks) — `e3094de-typecheck.log`.
- `bun run lint` → exit 0 — `e3094de-lint.log`.
- `bun test scripts/e2e-selection.test.ts scripts/sync-claude-skills.test.ts
  scripts/verification-rule.test.ts` → exit 0, 97 pass / 1 skip / 0 fail —
  `e3094de-scripts-suite.log`.
- Playwright: red-first `2 failed`, green `18 passed` (fix + purchase
  neighbours), full suite `96 passed (13.4m)` — see `e3094de-evidence.md`.
- Ablations A1/A2 → 2/2 red, files restored.
