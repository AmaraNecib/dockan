# Issue #96 — Standards axis (fixed point `071a1c4`, HEAD `9c856bb`)

Sources applied: `docs/engineering-workflow.md`, `docs/development-workflow.md` §3, `AGENTS.md`,
plus the Fowler smell baseline from `.agents/skills/code-review/SKILL.md`. Tooling-enforced
items (oxlint/tsc) skipped.

## Documented standard

**No hard violations found.** Evidence:

- `development-workflow.md` §3.3 ("UI text is Arabic-first with English keys via i18next") — every
  new string lands in `apps/web/src/lib/i18n.ts`; no Arabic literal appears in any `.tsx` hunk.
- `development-workflow.md` §3.2 ("user-facing flows have a Playwright E2E test") — new
  `tests/e2e/01-empty-states.spec.ts` plus the map `$comment` ("Adding a spec without wiring it here
  fails scripts/e2e-selection.test.ts") — wired. The four rule additions are legal; only redundant
  for this diff, since `apps/web/src/components/ui/**` and `lib/**` are `always_full`.
- `.scratch/implementation/96-design.md` and `.scratch/reviews/96/decisions.md` are tracked like the
  other 533 `.scratch` files, so not a source-only-policy breach.

## Baseline smells (all judgement calls)

1. **Duplicated Code** — `className="rounded border border-border bg-card"` is copy-pasted in 13
   hunks: `activity.tsx:120`, `diagnostics.tsx:121`, `categories.tsx:65`, `stock.tsx:345`,
   `returns.tsx:46,227`, `reports.tsx:154`, `invoices.tsx:113`, `items.tsx:793`,
   `party-detail.tsx:440,489,533`, `expenses.tsx:571`. The design doc says the new prop exists "so
   call sites stop wrapping it in a duplicated `rounded border bg-card`" (`96-design.md`) — the
   duplication moved into the prop string rather than disappearing. A shared constant or a
   `surface` variant would remove it.
2. **Divergent/inconsistent mechanism** (same problem, three techniques) — `categories.tsx:20`
   `useRef`; `expenses.tsx:592`, `invoices.tsx:137`, `items.tsx:206` module-scope
   `document.querySelector`/`getElementById`; `invoice.tsx:56` extracted `firstEnabledField` yet
   `expenses.tsx` inlines the same DOM query. One focus idiom would read as one intent.
3. **Mysterious Name** — `categoriesEmptyAction` = "اكتب اسم التصنيف" ("write the category name")
   is a hint sentence sitting in an action slot; sibling action keys name a step
   (`itemsEmptyAction` "منتج جديد", `expensesEmptyAction` "ابدأ التسجيل", `invoicesEmptyClearFilters`
   "مسح التصفية").

## Verdict

Standards axis: 0 hard violations, 3 judgement-call smells. Worst: the duplicated class string
(item 1), which undercuts the stated reason for adding `className`.
