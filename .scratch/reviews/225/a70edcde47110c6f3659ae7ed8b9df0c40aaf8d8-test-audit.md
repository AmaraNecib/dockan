# #225 — test audit

- **Reviewed SHA:** `a70edcde47110c6f3659ae7ed8b9df0c40aaf8d8` (head of `fix-225-ascii-readers`)
- **Stack base:** `afe15fe60c9e259b3650f8516f480172577b9f04` (`origin/fix-210-arabic-indic-money`, PR #229)
- **Diff:** `git diff afe15fe60c9e259b3650f8516f480172577b9f04...a70edcde47110c6f3659ae7ed8b9df0c40aaf8d8`
- **Tier:** Standard (recorded with justification in `.scratch/implementation/225-design.md`)
- **Reviewers:** three independent `reviewer` sub-agents (edge case hunter, coverage analyst,
  quality reviewer) at the SHAs above; a first round ran at `dfb719d`/`254469e` and its findings
  are folded in below.

## Gates run in-lane (all at the reviewed SHA unless noted)

| Command | Result |
| --- | --- |
| `bun install` | exit 0 — 189 packages installed |
| `bun run typecheck` | exit 0 — 4/4 tasks successful |
| `bun run lint` | exit 0 — oxlint, no findings |
| `bun run test` | exit 0 — 4/4 tasks successful, 0 fail |
| `DOKAN_PORT=4357 DOKAN_WEB_PORT=5197 bun run test:e2e tests/e2e/sale-checkout.spec.ts` | 4 passed (clean run on ports 4367/5207; the first attempt on the reused pair had one transient `scan-create…focuses-it-on-a-second-scan` failure that did not reproduce) |

## Pre-fix mutation (discriminating pin)

The brief requires at least one reader to show the pre-fix failure. Mutation applied to
`nextUnitCost` (`apps/web/src/lib/invoice-draft.ts`), reverting `parseLooseNumber(value)` to
`Number(value)`:

```
$ sed -i '224s/parseLooseNumber(value)/Number(value)/' apps/web/src/lib/invoice-draft.ts
$ bun test src/lib/invoice-draft.test.ts -t "#225"
Expected: 900
Received: 1200
(fail) nextUnitCost (the purchase line's controlled money field) > reads both Arabic-Indic scripts exactly like ASCII (#225)
 0 pass
 1 fail          # exit 1
```

Reverted immediately; `git status --short` clean and the test passes again. This proves the pin is
discriminating, not merely present.

## Findings and resolution

All three lenses report **no remaining in-scope gap** for the digit-script widening. Earlier rounds
raised the items below; every actionable one is fixed at the reviewed SHA.

| Finding (round) | Severity | Resolution |
| --- | --- | --- |
| purchase quick-add add-to-line reader (`purchase.tsx:107`) had no Arabic test (coverage) | orange | `purchase.test.tsx` "lands an Arabic-Indic quick-add cost on the purchase line it adds" pins `unitPrice: 1200` |
| Extended Arabic-Indic missing at page level for purchase/items (edge, coverage) | orange | `purchase.test.tsx` sell uses `toExtendedArabicIndic("200")`; `items.test.tsx` sell uses `۱۸۰` |
| items preview `toContain("80")` too shallow (quality) | orange | now `toBe(i18n.t("itemsProfitPerUnit", { profit: 80 }))` plus `not.toContain("…")` |
| digit translators duplicated in 6 files (quality, standards) | yellow | shared `apps/web/src/tests/arabic-digits.ts`; `amount-parse.test.ts` migrated too |
| safe-integer overflow not pinned in the Arabic loops (edge) | yellow | `9007199254740993` added to `numeric-input.test.ts` and `invoice-returns.test.tsx` identity loops; `invoice-draft.test.ts` already had it |
| Arabic negative / Arabic decimal separator not pinned in the strict reader (edge) | yellow | `-٥` and `٥٫٥` added to the `parseWholeNumber` refusal pin |
| no mutation artifact / e2e transcript (spec) | blocker→fixed | recorded above |
| `stock.tsx` page path has unit-only Arabic coverage (edge, coverage) | note | accepted: `stock.tsx` calls the same widened `parseSignedWholeNumber`/`parseWholeNumber` unit-tested in `numeric-input.test.ts`; a page pin adds no reader coverage. Left as a follow-up if the stock screen gains its own parsing |
| loose-reader decimal asymmetry `١٢٫٥` → NaN vs `12.5` → 12.5 (edge) | note | accepted and documented out of scope: #225 widens the digit **script**; separators were deliberately not widened by #229 either |
| purchase `act`+`setTimeout` idiom is fragile (quality) | note | style nit only; assertions are payload-level and pass. Not changed |

**Quality grade:** A (two prior-round flags properly resolved; only a style nit remains).

## Notes on test shape

- Per-reader Arabic test plus an ASCII-identity case exists for every widened reader in the
  inventory (see `-code-review.md`).
- Identity loops translate the whole draft set, including the refusal forms (`""`, `1e3`, `0x10`,
  `12.5`, `-5`, `abc`), so they pin "no semantic drift", not just one happy value.
- The shared fixtures are hand-written (`apps/web/src/tests/arabic-digits.ts`), never the production
  `normalizeArabicIndicDigits`, so the pins are not tautological.
