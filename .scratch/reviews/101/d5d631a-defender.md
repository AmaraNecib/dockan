# Defender — PR #111 / issue #101 (HEAD d5d631a, base 0b4d5a1)

## Defences

**1. The native selects are actually gone, not merely restyled (conf 10).**
`rg "<select" apps/web/src` returns a single hit — the doc comment at `apps/web/src/tests/select-driver.ts:5` ("replaced the last native `<select>` elements"). The screenshot control is now the themed primitive, `reports.tsx:78-89`:
```
<Select value={preset} onValueChange={(value) => setPreset(toPreset(value ?? ""))}
        items={PRESET_KEYS.map((key) => ({ value: key, label: t(`rangePreset_${key}`) }))}>
  <SelectTrigger className="w-full" data-testid="report-range-preset">
```

**2. Form semantics preserved, not silently dropped (conf 8).** `sale.tsx:445` keeps `name="quickCategory"` and `sale.tsx:495` keeps `name="discountType"`, so the hidden submitted input survives; tests assert exactly that (`sale.test.tsx:619`, `:657` → `document.querySelector('[name="discountType"]')`).

**3. Tokens follow the house pattern (conf 9).** `index.css:66-70` registers `--color-success: var(--success)` etc. inside `@theme inline`, with light/dark values at `:110-114` and `:150-154` — identical shape to the existing `--color-destructive` / `--color-primary` wiring. One place to change, both themes covered.

**4. Contrast is *proved*, not asserted in prose (conf 9).** `lib/a11y-contrast.test.ts:150-170` adds real compositing assertions: `--warning text stays >= 4.5:1 on its /10 tint over --card`, plus the layered-tint test that documents why the withdrawal badge became a solid fill.

**5. Complexity at the override is a genuine bug fix (conf 9).** `sale.tsx:481` adds `if (next === line.overrideType) return;` and `sale.test.tsx:722-735` pins it ("keeps a typed override value when the same type is re-selected"). A native `change` could never fire on same-value selection; without the guard the migrated control would wipe a typed price.

**6. `quickCategory` is one derived value, so display can't disagree with submit (conf 8).** `sale.tsx:318-321` ("Display and submit read this one value"), covered by the gated-categories test at `sale.test.tsx:624-641`.

**7. Rule enablement is evidence-led (conf 9).** `oxlint.config.ts:26-28` enables three rules; `no-unknown-classes` earned its keep by catching `font-display`, a class that generated no CSS (`app-sidebar.tsx:68,71` → `font-heading`). The two-file override (`oxlint.config.ts:48-55`) carries its own removal note and names the files the brief put out of scope.

**8. Test contracts got stricter, not looser (conf 8).** `tests/e2e/select-helpers.ts:9` adds `await expect(option).toBeHidden();` — every e2e now also proves the popup closes.

## False alarms
- "Behaviour changed by removing native selects" — hybrid `name` inputs and preserved `data-testid`s say otherwise; the only delta is defence 5, a fix with a regression test.
- "Lint override guts the rule" — it is path-scoped to two sibling-lane files with a removal condition, which the brief sanctions.
- "Raw HTML left unmigrated" — the brief allows recording why; design doc §5 does so per element.
- "Left-off rules = brief unmet" — the brief asked for `no-raw-colors` at minimum plus a stated reason for the rest (design doc §3).
