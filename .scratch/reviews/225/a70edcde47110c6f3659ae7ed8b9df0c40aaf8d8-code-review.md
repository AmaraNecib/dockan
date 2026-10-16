# #225 — code review (Standards + Spec)

- **Reviewed SHA:** `a70edcde47110c6f3659ae7ed8b9df0c40aaf8d8`
- **Fixed point:** `afe15fe60c9e259b3650f8516f480172577b9f04` (PR #229 head; this branch is stacked, not on `develop`)
- **Diff:** `git diff afe15fe60c9e259b3650f8516f480172577b9f04...a70edcde47110c6f3659ae7ed8b9df0c40aaf8d8`
- **Commits:** `dfb719d` fix → `254469e` test follow-ups → `a70edcd` test follow-ups
- **Reviewers:** independent `reviewer` sub-agents on the Standards and Spec axes, run at the reviewed SHA.

## Standards

**No documented-standard violations.** Verified:

- **One shared reader.** `numeric-input.ts` imports `normalizeArabicIndicDigits` from
  `@/lib/amount-parse`; every widened reader routes through `parseWholeAmount` (strict) or
  `parseLooseNumber` (loose). No second digits-normaliser exists.
  - `parseWholeNumber`/`parseSignedWholeNumber` → `apps/web/src/lib/numeric-input.ts`
  - `nextUnitCost` → `apps/web/src/lib/invoice-draft.ts`
  - sale quick-add cost/sell → `apps/web/src/pages/sale.tsx`
  - purchase quick-add cost/sell/threshold and add-to-line cost → `apps/web/src/pages/purchase.tsx`
  - customer-return validator / `valueTotal` projection / submit → `apps/web/src/pages/invoice.tsx`
  - free-standing supplier-return amount → `apps/web/src/components/parties/supplier-return-panel.tsx`
  - items profit preview → `apps/web/src/pages/items.tsx`
- **No ASCII parsing change** for the loose readers (`parseLooseNumber` is `Number` after digit
  normalisation); strict readers keep `^\d+$`.
- **No schema/contract/dependency change:** the diff touches `apps/web` and `.scratch/` only; no
  `package.json`/lockfile/schema hunk.
- **Source-only staging:** `git status --short` clean; no generated artifacts.
- **#227 bidi untouched:** no `U+200E/200F/202A-E/2066-9` introduced.

**Judgement calls (disclosed, not violations):**

1. `invoice.tsx` `valueTotal` moved from `Number(draft)` to strict `parseWholeAmount`, so ASCII
   `1e3` now projects as "not a line" (it previously projected 1000). The validator already refused
   `1e3`, so no submittable number changes; agreement between projection and submit is the point of
   #229 and #225. Pinned by `invoice-returns.test.tsx` "projects only drafts the validator will
   submit, so preview and submit agree (#225)" and documented in the design doc.
2. `invoice.tsx` submit uses a defensive `flatMap` dropping a `null` that validation makes
   unreachable. Kept deliberately: `parseWholeAmount` returns `number | null`, and a type assertion
   would need a SAFETY comment (`require-safety-comment-for-type-assertion`).
3. `parseWholeNumber` is now behaviourally identical to `parseWholeAmount`. Two names, one rule;
   left because callers already depend on each module's surface and merging them is a separate
   refactor.
4. Shared test fixtures landed in `apps/web/src/tests/arabic-digits.ts` (alongside `router-mock.ts`
   and `select-driver.ts`), removing the earlier six-way duplication.

## Spec

Every requirement of issue #225 and the brief is satisfied at the reviewed SHA:

| Requirement | Status |
| --- | --- |
| Widen the readers #229 left ASCII-only | Done — inventory below |
| Enumerate the actual list and report misses | Done — design doc §Reader inventory; two misses found and fixed (`profitPreview`, purchase quick-add) |
| One shared reader; no second normaliser | Done |
| No schema/contract/dependency change | Done |
| Do not touch #227 bidi | Done |
| Preserve ASCII semantics per reader (`1e3`/`0x10`/`12.5`/`""`) | Done, pinned per reader |
| Tier Standard + one-line justification in the design doc | Done (`.scratch/implementation/225-design.md`) |
| Per-reader test + ASCII-identity case | Done |
| `bun run typecheck`, `bun run lint`, `bun run test` | Done, exit 0 |
| e2e `tests/e2e/sale-checkout.spec.ts` | Done — 4 passed |
| Pre-fix mutation for at least one reader | Done — see `-test-audit.md` |
| Evidence `.scratch/reviews/225/<head-sha>-{test-audit,code-review}.md` | This file + the test audit |

### Reader inventory (enumerated from the code, not the brief)

In scope: `nextUnitCost`; `numeric-input.ts` `parseWholeNumber`/`parseSignedWholeNumber` (and
`resolveOpeningStock`, backing items, stock, and the quick-add stock field); sale quick-add cost/sell;
customer-return quantity validator + `valueTotal` projection + submit payload; free-standing
supplier-return amount.

Found by the enumeration, not in the brief: `profitPreview` (`items.tsx`) and purchase quick-add
cost/sell/threshold (`purchase.tsx`). Both were raw `Number` drafts untouched by #229, so the brief's
"the list is a hint, not an inventory" clause covers them.

Deliberately out of scope (recorded in the design doc): pager/pagination page numbers; barcode
reader; date parts; `invoiceSequence`; `activity.tsx` `Number(debt)`; `vault-client.ts`
`Number.parseInt`; the Arabic decimal/thousands separators.

### Per-reader ASCII semantics preserved

| Reader | `1e3` | `0x10` | `12.5` | `""` |
| --- | --- | --- | --- | --- |
| `nextUnitCost` | 1000 | 16 | previous | 0 |
| `parseWholeNumber`/`parseSignedWholeNumber` | null | null | null | null |
| sale quick-add cost/sell | 1000 | 16 | rejected | 0 |
| invoice-return quantity | INVALID | INVALID | INVALID | untouched |
| supplier-return free-standing amount | 1000 | 16 | rejected | 0 |
| `profitPreview` | 1000 | 16 | 12.5 | 0 |
| purchase quick-add cost/sell/threshold | 1000 | 16 | rejected (cost) / accepted (threshold) | 0 / fallback |

### Scope creep

None. The two extra readers are the brief's invited enumeration misses. No unrequested behaviour
change beyond the disclosed `valueTotal` projection narrowing, which is a preview/submit consistency
fix.
