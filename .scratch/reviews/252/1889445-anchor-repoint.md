# #252 — the mutation proof's M3 anchor, re-pointed at #264's typed-row control

**HEAD:** `1889445` (this file lands in a follow-up `.scratch/`-only commit; the
reviewable change is zero files).
**Base:** `origin/fix-252-direction-labels` (`f9785376`) → PR #267.
**Tier:** Standard, per the brief. The diff is `.scratch/**` only, which the
workflow's Lightweight row covers; the Standard lenses for the product change
already exist at `0a30eee-test-audit.md` / `0a30eee-code-review.md` and are not
stale, because no reviewable file changed since `0a30eee` (guard Phase 2
staleness rule: only `.scratch/` moved).

## What was wrong

`M3`'s `find` was the removed multiline new-row `Select`
(`items={directionItems}` / `value={newDirection}`). The rebase onto
`develop@4ad7076` (#264) reshaped `supplier-opening-balance.tsx`: the new-row
flow became `typedRows`, and its direction control is now a single-line
`<Select … value={typedRow.direction} …>`. The anchor matched nothing, so the
gate printed `M3 ANCHOR MISSING` and exited 1 while the other 15 mutations were
caught. That names no claim — the exact failure the finding is about.

## Red — `.scratch/reviews/252/anchor-repoint-red.log` (pre-fix, HEAD `f978537`)

```
# phase 1 — green baseline (unmutated suites)
  apps/web: 5 suite(s) exit=0 named failures=0
  baseline green

--- M3: drop items={directionItems} from the new-row direction Select
      ANCHOR MISSING — mutation not applied

PROBLEMS: M3 ANCHOR MISSING
real	7m33.151s        exit=1
```

## Green — `.scratch/reviews/252/anchor-repoint-green.log` (post-fix, HEAD `1889445`)

```
# phase 1 — green baseline (unmutated suites)
  apps/web: 5 suite(s) exit=0 named failures=0
  baseline green

# phase 2 — ablation (16 mutations)
--- M1  … --- M16            (16 ids, in order, below)
--- M3: drop items={directionItems} from the typed-row direction Select
      (fail) Select trigger label guard (issue #252) > gives every Select that renders a SelectValue a usable value→label map [728.46ms]
      (fail) SupplierOpeningBalancePage (issue 176) > #252 — the direction select reads the Darija label, never the raw enum, and submits the value its label names [99.72ms]
      exit=1 named failures=2

# restore check
OK   apps/web/src/lib/i18n.ts
OK   apps/web/src/pages/supplier-opening-balance.tsx
OK   apps/web/src/components/parties/supplier-adjust-panel.tsx
OK   apps/web/src/lib/supplier-entry-display.ts
OK   apps/web/src/lib/select-trigger-label.test.ts

ALL MUTATIONS REDDENED, ALL FILES RESTORED BYTE-IDENTICAL
real	6m40.070s        exit=0
```

Command: `bun .scratch/reviews/252/mutation-proof.ts` (cwd = repo root).

## The anchor touched

`M3` → `apps/web/src/pages/supplier-opening-balance.tsx:915`, quoted:

```
                        <Select items={directionItems} value={typedRow.direction} onValueChange={(next) => setTypedRow(typedRow.id, { direction: asDirection(next) })}>
```

`replace` drops `items={directionItems}`. The sibling supplier-row control at
`:848` reads `value={draft.direction}`, so the anchor is unique to the typed row.

## The other 15 anchors — still live, each matched exactly once

Audited with a throwaway matcher (deleted before the commit) that re-read each
mutation's `find` from the script and reported the first matching line in the
target file. `ANCHOR MISSING` in the run would flag a dead anchor; the green run
prints a named `(fail)` line per id, so "matched" and "bites" are both measured.

| id | file | line | what the anchor now targets (first line, quoted) |
| --- | --- | --- | --- |
| M1 | `apps/web/src/lib/i18n.ts` | 995 | `      supplierAdjustDirectionWeOwe: "يسالنا",` |
| M2 | `apps/web/src/lib/i18n.ts` | 997 | `supplierAdjustDirectionWeOweHint: "نحن ندين له — يزيد ما علينا"` |
| M3 | `apps/web/src/pages/supplier-opening-balance.tsx` | 915 | `<Select items={directionItems} value={typedRow.direction} onValueChange={(next) => setTypedRow(typedRow.id, { direction: asDirection(next) })}>` |
| M4 | `apps/web/src/components/parties/supplier-adjust-panel.tsx` | 226 | ` items={openInvoices.map((invoice) => ({ value: invoice.id, label: invoice.invoiceNumber }))}` |
| M5 | `apps/web/src/lib/supplier-entry-display.ts` | 62 | `  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";` |
| M6 | `apps/web/src/lib/select-trigger-label.test.ts` | 163 | `rendersSelectValue(node) && !isUsableMap(itemsExpression(node.openingElement), emptyBindings)` |
| M7 | `apps/web/src/lib/select-trigger-label.test.ts` | 150 | `  if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 0) return false;` |
| M8 | `apps/web/src/lib/supplier-entry-display.ts` | 81 | `  return supplierDirectionKey(balance >= 0 ? "WE_OWE" : "THEY_OWE");` |
| M9 | `apps/web/src/lib/supplier-entry-display.ts` | 73 | `  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOweHint" : "supplierAdjustDirectionWeOweHint";` |
| M10 | `apps/web/src/pages/supplier-opening-balance.tsx` | 726 | `    { value: "WE_OWE", label: t(supplierDirectionKey("WE_OWE")) },` |
| M11 | `apps/web/src/lib/select-trigger-label.test.ts` | 153 | `  if (ts.isIdentifier(unwrapped) && (unwrapped.text === "undefined" \|\| unwrapped.text === "null" \|\| emptyBindings.has(unwrapped.text))) return false;` |
| M12 | `apps/web/src/lib/select-trigger-label.test.ts` | 154 | `  return !labelsAreRawValues(unwrapped);` |
| M13 | `apps/web/src/components/parties/supplier-adjust-panel.tsx` | 143 | `onClick={() => setDirection("WE_OWE")}` |
| M14 | `apps/web/src/lib/select-trigger-label.test.ts` | 181 | `    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select" && rendersSelectValue(node)) seen += 1;` |
| M15 | `apps/web/src/lib/select-trigger-label.test.ts` | 117 | `  if (ts.isStringLiteral(name)) return name.text;` |
| M16 | `apps/web/src/pages/supplier-opening-balance.tsx` | 48 | `const asDirection = (value: string \| null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");` |

No mutation lost its target to #264, so the table stays 16 rows — nothing is
marked "no longer applicable".

## Gates

| gate | command | exit |
| --- | --- | --- |
| typecheck | `bun run typecheck` | 0 |
| lint | `bun run lint` | 0 |
| proof script compiles | `cd apps/web && bunx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --types bun ../../.scratch/reviews/252/mutation-proof.ts` | 0 |
| gate verdict logic | `bun test ./.scratch/reviews/252/mutation-proof-gate.test.ts` | 0 (9 pass, 0 fail) |
| full suite | `bun run test` | **not run**: refused by the shared heavy-run guard, both e2e slots held (`feat-257-inline-product-round5`, `fix-260-preview-direction`). Narrowed instead: the proof's own green baseline covers the 5 suites it names, all exit 0. |

`bun run lint` does not read `.scratch/**` (`oxlint.config.ts` ignorePatterns),
and `bun run typecheck` is turbo over `apps/*` — so the standalone `tsc` above is
the check that actually covers this TypeScript change. Named rather than
implied: the root gates exit 0 but would exit 0 on a broken `.scratch` script.

## Decisions

- **Re-pointed, not dropped.** #264 removed the new-row `Select`, but the
  typed-row control makes the same claim (a row direction control carrying a
  value→label map), so the mutation still has a target. Dropping it would have
  shortened the table without needing to.
- **No new row for the supplier-row control at `:848`.** The guard test
  (`select-trigger-label.test.ts`) scans every `Select` site in `apps/web/src`,
  and M3 proves it bites on this page. A second page-level row would widen the
  table past the brief.
- **Drill not re-run.** This change *is* the anchor check; the red run (exit 1,
  naming M3) is the direct proof the check bites. The drill's D1/D2 anchors are
  independent of this edit.
