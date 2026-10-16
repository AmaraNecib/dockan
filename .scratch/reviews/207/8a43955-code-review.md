# Code review — issue #207 (extract a `submitForm()` helper and close the opening-balance boundary gaps)

- **Lane:** `test-207-submitform-helper` (branch `test-207-submitform-helper`)
- **Base (target `develop`):** `origin/develop` @ `1ea76b5cd9ea7a7d88133564c73eaad12e9a8aee`
- **Reviewed HEAD SHA:** `8a43955632aad80b060511ae0697473a2d1e161a`
- **Tier:** Standard.
- **Diff:** `git diff 1ea76b5...8a43955` — `.scratch/implementation/207-design.md` (new) + `apps/web/src/pages/supplier-opening-balance.test.tsx` (modified). Production file count: **0**.

Two axes, each run as an independent reviewer sub-agent, over three review rounds (`686f949` → `3925ba3` → `8a43955`). Findings are aggregated below with their disposition; the separation between axes is preserved.

## Invariants

- **Test files and helpers only; no production change** — `git diff --name-status 1ea76b5...HEAD` is exactly `A .scratch/implementation/207-design.md` and `M apps/web/src/pages/supplier-opening-balance.test.tsx`.
- **No assertion weakened or deleted** — `git diff origin/develop...HEAD -- ...test.tsx` contains **0** removed lines with `expect(`; the only deletions are inline `requestSubmit()` scaffolding and comments. Assertion count grows 256 → 283 at runtime.
- **Approach** — the abandoned `fix-207-submitform-helper` commits were judged sound and cherry-picked onto current `develop` (clean apply), then brought up to the acceptance bar.

## Standards axis

| Round | Finding | Kind | Disposition |
|---|---|---|---|
| 1 | Design's mutation table claimed "Verified in this lane" over two rows labelled "(inherited)" | **Hard** (evidence accuracy, `docs/engineering-workflow.md` "an unstated gate is an unrun gate") | Fixed: all four mutations were re-run in-lane and the commands/exit codes are recorded in `8a43955-test-audit.md` |
| 1 | Helper JSDoc named row 1 as `s-2`, false under `TWO_NO_ENTRY_SUPPLIERS` (row 1 = `s-b`) | Hard | Fixed at `3925ba3`: JSDoc names both fixtures |
| 2 | Design said the mutation table was verified "on this HEAD" while `3925ba3` changed the test file after `686f949` wrote it | Hard | Fixed: wording now keys on the production files, which are byte-identical at every commit here, and the commands live in the test-audit evidence |
| 2 | Helper JSDoc still promised "Assertions stay in the test body afterwards", contradicted by the accept tests' in-arm assertion | Judgement | Fixed at `8a43955`: JSDoc documents the in-arm accept variant and the row-1 invariant |
| 2 | Residual duplicated supplier fixtures (`Data Clumps`) and the repeated 3-line reject assertion block | Judgement | Left as-is: test explicitness is deliberate; the extraction target was the submit scaffold |
| 3 | `.scratch/reviews/207/` empty while the design cited it | Hard | Closed by writing this file and `8a43955-test-audit.md` |

Round-3 Standards verdict: **no hard standard violation** in the final diff; the only remaining notes are the judgement calls above. Prose follows the repo's `#NNN —` comment convention (unslop: no em-dash/filler drift introduced).

## Spec axis

Spec: `gh issue view 207` + `.scratch/implementation/207-design.md`.

- **Req 1 — `submitForm()` helper** ("fill a valid no-entry row, arm the failure, `requestSubmit()`"): implemented at `supplier-opening-balance.test.tsx:324`; used by all 8 PR-#203 sites and all 8 new tests.
- **Req 2 — boundary cases:**
  - "a **negative** amount draft" — `rejects a negative amount draft instead of saving its magnitude`.
  - "amount boundaries at the low and high ends" — amount `1` accept, `MAX_SAFE_INTEGER` accept, `0` reject, `MAX_SAFE_INTEGER + 1` reject.
  - "the 200-row limit **at** the boundary, not just over it" — exactly 200 filled rows accept, and 199 filled + 1 typed = 200 accept; the pre-existing over-limit (201) reject remains.
- **"Known exception to document, not fix here"** (confirm-save `captured === null` masked by the disabled control): documented in the test comment with a do-not-weaken warning; the assertion is kept.

Round-1 Spec finding: the design claimed the helper covered "the new boundary tests" while two accept tests bypassed it, and the mutation table mixed verified/inherited rows. Both **fixed at `3925ba3`**: every new test now routes through `submitForm`, and the mutation table is fully verified.

Round-3 Spec verdict: **no missing or partial requirement; no scope creep beyond the fixture/design support the change needs; no implemented-but-wrong behaviour.**

## Summary

- **Standards axis:** 1 open hard issue at review time — the empty `.scratch/reviews/207/` evidence directory cited by the design — closed by this file; all other hard findings fixed. Remaining items are judgement-call test-duplication notes.
- **Spec axis:** 0 findings (all closed).
- **Local gates at `8a43955`:** `bun run typecheck` 0, `bun run lint` 0, `bun run test` 0, file `69 pass / 0 fail`.

Lane authority: commit only. No push, no PR, no merge.
