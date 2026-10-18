# #101 — Spec-axis review (HEAD d5d631a, base 0b4d5a1)

## Correct
- Spec item 1 (four selects): no native `<select` remains (`rg "<select" apps/web/src --glob '*.tsx'` → 0 hits). Reports preset, quick-add category, per-line override, invoice discount all use the themed `Select`; `data-testid`/`name`/`aria-label` preserved.
- Spec item 3: `oxlint.config.ts:29` `"shadcn/no-raw-colors": "error"` plus `no-unknown-classes`/`require-static-classes`; three left off ("If a rule cannot pass without unrelated churn, enable the rest and say which you left and why") with reasons in `101-design.md` §3.
- Spec item 4: raw-HTML audit recorded in §5; `<input>`/`<button>`/`<table>` survivals justified.
- Repo/helper constraint: `tests/e2e/select-helpers.ts` extended; all `.selectOption` call sites migrated (sale-checkout, expense-reports, invoice-payments, learnability, receipts, returns).

## Wrong (implemented, contradicted by its own design doc)
- `101-design.md` §2: "`--warning` has no solid surface in the app, so it needs no foreground companion" — false. `index.css:70,114,154` add and register `--warning-foreground`, and the badge is a solid surface:
  `apps/web/src/pages/reports.tsx:174` `` `rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground` `` and `apps/web/src/pages/expenses.tsx:297` (identical).
- The §2 mapping table says `bg-amber-200 + text-amber-900` → `bg-warning/20` + `text-warning`, but the code uses solid `bg-warning` + `text-warning-foreground`. The doc was not updated for commit d5d631a ("fill the withdrawal badge"), so it now describes a different treatment than ships. Contrast claims in §2 ("white on a solid `bg-success` 6.0:1") never cover the solid-warning badge. Reconcile the doc or the class.

## Partial
- Acceptance "No raw palette class … remains, or each survivor is documented as intentional": 4 survivors remain (`items.tsx:85`, `stock.tsx:120,202`), documented in §4/§6 — but the gate is weakened by `oxlint.config.ts:50-53` turning `no-raw-colors` **off** for those files. Compliant only via override; the "rule beats a convention" guarantee does not hold app-wide.

## Note
- Arithmetic does not reconcile: issue/brief say 37 raw classes; `git grep -o` at base = 37 occurrences, survivors = 4, so 33 were replaced. `101-design.md` §2 and `pr-101.md` both claim "31".
- Scope creep (minor, justified in §3): `app-sidebar.tsx:68,72` `font-display`→`font-heading`, `button.test.tsx` fixture — both needed for `no-unknown-classes`.
- Behaviour parity: override guard `if (next === line.overrideType) return;` (`sale.tsx`) and `quickCategory = quickCategoryId || categories.data?.items[0]?.id || ""` reproduce native semantics; no spec violation.
- Light/dark correctness for every migrated control is asserted only by added unit/e2e tests; not independently reproduced here.

Overall: all four spec work items are present; the only spec-axis defect is the design-doc/solid-warning inconsistency.
