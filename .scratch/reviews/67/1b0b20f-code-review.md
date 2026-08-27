# Code review — issue 67 (category name in items list)

**Issue:** #67. **Base:** `f4d4674`. **Head:** `1b0b20f` (final; reviewed at
`2a2bbc7`, post-review commit `1b0b20f` is the audit-recommended E2E race
hardening only).
**Tier:** Standard. Two-axis review: Standards + Spec sub-agents in parallel
against `git diff f4d4674...HEAD` (commits: `2a2bbc7` fix, `1b0b20f` e2e
hardening).

## Standards

**Documented standards — no violations (hard).** AGENTS.md imposes no code
rules. engineering-workflow.md gates satisfied: design doc at
`.scratch/implementation/67-design.md` records tier, base SHA, rejected
options (Option B, base-`itemSchema` extension), test seams. Pattern
consistency: `itemListOutputSchema` follows the `<x>OutputSchema` convention
(`lowStockOutputSchema`, `activityListOutputSchema`); `itemListItemSchema`
reuses `itemSchema.extend`; the `"—"` fallback mirrors the table's existing
barcode fallback.

**Baseline smells — all suppressed (judgement calls):**
- Shotgun Surgery (weak): touches 6 source/test files + design doc, but each
  edit sits at its layer-appropriate home (schema → port signature → one query
  → one UI cell); base `itemSchema` deliberately untouched to bound the ripple.
- Primitive Obsession (weak): `categoryName: z.string().nullable()` — repo-
  consistent (category names are strings everywhere), display-only field.
- Duplicated Code (weak): store/router tests repeat create→assert; they pin
  two distinct confirmed seams (tdd-seam doctrine), intentional.

If tooling were to flag anything: lint + typecheck + full test suite run
green after the final commit (see Guard evidence).

## Spec

Spec = issue #67: items table renders `{item.categoryId}` raw UUID in the
التصنيف column; store `listItems` returns no join; fix so the user sees the
category NAME.

- **(a) Missing/partial — none.** Both halves present: store join
  (drizzle-store.ts:655-660, `leftJoin(categories, ...)` selecting
  `categoryName`) and UI render (items.tsx:427 `{item.categoryName ?? "—"}`,
  map callback typed `ItemListItem`). Contracts updated coherently
  (`itemListItemSchema`/`itemListOutputSchema`/`ItemListItem`, app-contract
  `itemsList` output).
- **(b) Scope creep — none.** Base `itemSchema` and all other item methods
  untouched; only `listItems` gains the joined field.
- **(c) Implemented-but-wrong — none found.** Verified: store test asserts
  `categoryName == name` and `categoryId` unchanged; router test proves the
  wire carries `categoryName` (no zod stripping); E2E label resolution
  (`getByLabel("التصنيف")` ↔ i18n key `itemsCategory`) and `selectOption`
  are valid; assertion checks the NAME not a UUID. Same `categoryId`-rendering
  pattern in reports.tsx/expenses.tsx is outside the issue's cited table and
  not a defect.

## Summary

Standards: 0 hard violations, worst issue a suppressed weak judgement call.
Spec: 0 findings. Approved.