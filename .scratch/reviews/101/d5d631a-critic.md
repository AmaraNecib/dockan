# Critic review — PR #111 / feat/101-design-hygiene @ d5d631a (base 0b4d5a1)

Read-only. No tests run (task forbids it); every claim comes from source, diff, or arithmetic.

6 | apps/web/src/lib/a11y-contrast.test.ts:163-166 | The headline badge guard guards nothing: `const layered = tintOver("warning", 0.2, tintOver("warning", 0.1, surface("card"))); expect(contrast(toRgb(value("warning")), layered)).toBeLessThan(contrast(toRgb(value("warning")), surface("card")));` hand-composes tokens, then asserts a tautology plus the failure of a design that no longer exists (`if (theme.name === "light") expect(...).toBeLessThan(TEXT_MIN)`). Revert the badge to `bg-warning/20` (reports.tsx:174, expenses.tsx:297) and it still passes — the file never renders the badge. Meanwhile the pairing that ships, normal `--foreground` body text on `bg-warning/10` (reports.tsx:144,171; expenses.tsx:293; sale.tsx:500), is untested. | Assert `contrast(foreground(), tintOver("warning", 0.1, surface("card")))` and the plain-card pair; drop the "loses contrast" block.

5 | apps/web/src/pages/sale.test.tsx:674-686 | "keeps a typed override value when the same type is re-selected" may be vacuous — it would pass against the unguarded implementation. It activates the already-selected option twice; if Base UI emits no `onValueChange` for a same-value pick, `if (next === line.overrideType) return;` (sale.tsx:483) can be deleted and the test is green, so the guard pr-101.md calls a "real behaviour fix" is unverifiable. | Add a negative control proving the guard is required, or drop guard and test together.

5 | apps/web/src/pages/returns.tsx:108, apps/web/src/index.css:110 | Destructive action regressed to the AA boundary: `bg-red-700 text-white` → `bg-destructive text-destructive-foreground`, i.e. `oklch(0.985 0 0)` on `oklch(0.577 0.245 27.325)`. OKLCH→WCAG arithmetic gives ≈4.56:1 (linear luminance ≈0.9557 vs ≈0.1705) — 0.06 above 4.5 on `text-sm`, down from ≈7:1; returns.tsx:96 has the same shape. returns.tsx:108 also visibly brightens a destructive button, against "hygiene, not a redesign". | Give solid fills their own darker token (or a lighter foreground) and keep margin above 4.5.

4 | oxlint.config.ts:48-55 | Nothing proves the three rules can fail. The only evidence `shadcn/no-raw-colors` executes is this override, whose `files: ["apps/web/src/pages/items.tsx", "apps/web/src/pages/stock.tsx"]` are literal paths while oxlint's own examples use globs (`files: ["*.test.ts","*.spec.ts"]`, node_modules/oxlint/dist/index.d.ts:432-470). Those files still carry raw palette classes (items.tsx:85, stock.tsx:120, stock.tsx:202), so a green lint means either the override matched or the rule is inert; a bad rule id or an unloaded plugin also exits 0. | Add a negative control (fixture expected to error) or use `**/items.tsx`.

3 | apps/web/src/pages/items.tsx:85, apps/web/src/pages/stock.tsx:120,202 | Raw palette survives in shipped UI behind the lane's one rule disable. Acceptance demands survivors be "documented as intentional"; lane ownership is scheduling, not intent. | Tokenise now (`text-success`, `bg-success/10`) or name a dated remover.

3 | tests/e2e/expense-reports.spec.ts:181-190 | New preset test passes with a broken handler: it checks only `data-slot`, trigger text, and the absence of `report-custom-*`. A `onValueChange` (reports.tsx:80) that relabels without re-querying the range satisfies every line. | Assert an observable range effect (`report-range-label`).

3 | apps/web/src/pages/reports.test.tsx:178-192 | Class strings, not output: `toContain("text-warning-foreground")` passes even if that token were never registered at index.css:66-70 (class present, no CSS). It snapshots source text, not the fix. | Assert the token is registered plus a contrast margin.

2 | apps/web/src/pages/sale.tsx:318-321 | The comment ("the trigger can never show nothing") is false in the state it targets: with `categories.data` undefined, `quickCategory` is `""`, the trigger shows a placeholder, submit errors `itemsChooseCategory`, and the popup renders zero options (sale.tsx:445) — worse than the old empty native select. | Add a loading/empty state and disable the Select until categories land.

2 | apps/web/src/router.test.tsx:189-192 | Rewritten wait (`textContent?.trim() !== ""`) proves only that some label rendered; a wrong fallback still passes. | Assert the expected category name.

1 | apps/web/src/tests/select-driver.ts:38-51 | `findOption` matches `textContent.includes(label)`; a label that is a substring of another option silently commits the wrong item ("مبلغ" vs a future "مبلغ مقطوع"). 100 × 10ms retries also turn regressions into timeouts. | Match `data-value`/exact name; shrink the loop.

1 | tests/e2e/select-helpers.ts:9 | `await expect(option).toBeHidden()` depends on `data-closed:animate-out` finishing inside the retry window across all six converted specs. | Keep unless CI flakes.

Not flagged: the four native-select conversions are faithful — values, `name`, `aria-label`, `data-testid` preserved (sale.tsx:444-448,496; reports.tsx:78-89), keyboard/close coverage added, and the new tokens are correctly wired into `@theme inline`.
