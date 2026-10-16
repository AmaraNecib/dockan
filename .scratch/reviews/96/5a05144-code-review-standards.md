# Issue #96 — Standards axis (fixed point `071a1c4`, round-2 HEAD `5a05144`)

Sources: `docs/development-workflow.md` §3, `docs/engineering-workflow.md`, `AGENTS.md`, plus the
Fowler smell baseline from `.agents/skills/code-review/SKILL.md`. Tooling-enforced items
(oxlint/tsc/test ids) skipped.

## Documented standard — 0 hard violations

- §3.3 (Arabic-first, English keys via i18next): every new string lands in `apps/web/src/lib/i18n.ts`;
  no Arabic literal in any `.tsx` hunk; the new `i18n.test.ts` block enumerates the #96 keys and
  asserts non-empty Arabic.
- §3.2 E2E: `tests/e2e/01-empty-states.spec.ts` exists and is wired into
  `tests/e2e-selection.map.json`. §3.4: no generated artifact in the diff; `.scratch` evidence is
  tracked like the existing 533 files.
- `engineering-workflow.md` evidence-path rule is met by this filename; the round-1
  `9c856bb-*` files are stale by design, not a breach.

## Baseline smells (all judgement calls)

1. **Duplicated Code** — round 1's item 1 is still open. 12 hunks hand the same surface string to the
   new prop: `className="mt-4 rounded border border-border bg-card"` at `activity.tsx:122`,
   `categories.tsx:68`, `diagnostics.tsx:123`, `expenses.tsx:578`, `invoices.tsx:115`,
   `items.tsx:802`, `party-detail.tsx:442/491/535`, `reports.tsx:156`, `returns.tsx:49,230`
   (25 such literals repo-wide). The design doc says the prop exists "so call sites stop wrapping it
   in a duplicated `rounded border bg-card`" — the duplication moved into the argument.
2. **Duplicated Code (new, delta)** — the new `apps/web/src/tests/page-harness.tsx` is barely adopted.
   Three new specs use it, while 15 page specs this diff edits (`expenses`, `invoices`, `items`,
   `invoice`, `party-detail`, `returns`, `reports`, `diagnostics`, `purchase`, …) still hand-roll
   `createRoot` + act-wrapped poll (`purchase.test.tsx` mounts `createRoot` 9×). One definition, many
   copies — the harness comment claims "every page spec otherwise reimplemented the same dance".
3. **Inconsistent mechanism (delta)** — "categories unavailable" now means two things:
   `items.tsx:797` `const categoriesUnavailable = categories.isError` vs `expenses.tsx:181`
   `categories.data === undefined`. Same concept, opposite predicates; a failed read behaves
   differently on the two screens.
4. **Heterogeneous focus idiom** — round 1's item 2 is unchanged: `categories.tsx:20` `useRef` vs
   `invoice.tsx:56` `firstEnabledField` vs inline
   `document.querySelector('[data-testid="…"]')` in `expenses.tsx:592`, `invoices.tsx:135`.
5. **Mysterious Name — resolved.** `categoriesEmptyAction` "اكتب اسم التصنيف" → "أضف تصنيفاً"
   (`i18n.ts:164`). It now reads as an action, though the control only focuses the adjacent field.

**Note** — `items.test.tsx:441` comments that the action "exists while it is pending": a *pending*
category read still renders an add button that may become a dead end.

Worst: smells 1 and 2, both surviving a review round.
