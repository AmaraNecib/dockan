# Standards review — PR #111 / issue #101 (HEAD `d5d631a`, base `0b4d5a1`)

Scope: hard violations of documented repo standards, then Fowler baseline smells as judgement calls.
Standards applied: `.github/copilot-instructions.md`, the #101 brief, the issue (`.scratch/implementation/i-design-hygiene.md`).

## Correct (standard-compliant)

- **Brief item 3 satisfied.** `oxlint.config.ts:23-35`: `"shadcn/no-raw-colors": "error", "shadcn/no-unknown-classes": "error", "shadcn/require-static-classes": "error",` plus a scoped override `files: ["apps/web/src/pages/items.tsx", "apps/web/src/pages/stock.tsx"], rules: { "shadcn/no-raw-colors": "off" }` with the removal condition the brief asks for.
- **Brief item 1 satisfied.** No `<select` remains; `reports.tsx:78-90` renders `<SelectTrigger className="w-full" data-testid="report-range-preset">`, `sale.tsx:443-452` keeps `name="quickCategory"`, `data-testid`s preserved.
- **Palette rule respected.** `copilot-instructions.md` "Green for success only … Red for destructive/error. Amber for warnings" holds: `returns.tsx:96` `bg-success … text-success-foreground`, `returns.tsx:108` `bg-destructive … text-destructive-foreground`, `--warning: oklch(0.5 0.14 62)`.

## Hard violations

None substantiated. The sole candidate — `copilot-instructions.md` "Avoid pure #000 and #fff" — is covered by documented survivors: the 5 print hex literals are argued in `101-design.md §2` ("forcing them through OKLCH tokens would couple print output to the screen palette"), which the brief permits ("or each survivor is documented as intentional").

## Notes (judgement calls)

1. **Duplicated Code (Fowler).** Each migrated Select states its options twice — as `items` and as `SelectItem` children. `sale.tsx:495`: `items={[{ value: "", label: t("saleNoDiscount") }, { value: "AMOUNT", label: t("saleDiscountAmount") }, …]}` alongside `<SelectItem value="">{t("saleNoDiscount")}</SelectItem>`. Same shape at `sale.tsx:481`; `reports.tsx:81` `items={PRESET_KEYS.map((key) => ({ value: key, label: t(`rangePreset_${key}`) }))}` vs its `SelectContent` children. A mild Data Clump (`{ value, label }` pairs). It mirrors the 28 pre-existing usages, so it is consistent rather than novel; one source could feed both.
2. **Scope boundary.** `app-sidebar.tsx:68,72` renames `font-display` → `font-heading`, in the nav shell the brief assigns elsewhere ("No dashboard, no navigation restructure (#102 is separate)"). Justified by `no-unknown-classes` (`101-design.md §3`: "`font-display` in `app-sidebar.tsx` generated no CSS. Renamed to `font-heading` (identical Tajawal face, no visual change)") and visually inert — but it is absent from the PR body.
3. **Doc/code drift.** `101-design.md:71` states "`--warning` has no solid surface in the app, so it needs no foreground companion", yet `d5d631a` added `--warning-foreground` and solid fills at `expenses.tsx:297` / `reports.tsx:174`. Stale prose only.
