# Evidence — #257 review round 3 (PR #266)

- **Head:** `e3094de` · **Pre-fix tree:** `da5f336` (merge of `origin/develop`
  `03d1878` into `origin/feat-257-inline-product` `a6838f0`)
- **Tier:** standard · **Runner:** the lane's own session, commands below run in
  `D:/projects/mani-worktrees/feat-257-inline-product-round3`
- **Note on SHAs:** the fix commit was message-amended after the reviews ran, so
  its final SHA is `ae9d4b5` while the evidence and the review axes are named
  `e3094de-*` (the SHA the reviewers were pinned to).
  `git diff --name-only e3094de ae9d4b5` prints nothing — the amend touched the
  commit message only — so the named evidence is valid for the final head as
  well. The red run predates the fix and keeps the pre-fix SHA `da5f336`, which
  is what it actually measured.
- **e2e slot:** `e2e-slot.sh` slot1 →
  `DOKAN_PORT=4700 DOKAN_WEB_PORT=5700 DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701`

## 1. The merged code that fixes the expected prefix (read, not assumed)

```
apps/api/src/lib/document-number.ts:12-13
  export const invoiceNumberPrefixes = {
    SALE: "INV",
    PURCHASE: "SUP",
  } as const satisfies Record<InvoiceKind, string>;

apps/api/src/rpc/router.ts:1324
  const invoiceNumber = await tx.allocateInvoiceNumber("PURCHASE");

apps/api/src/store/drizzle-store.ts:1848
  async allocateInvoiceNumber(kind) { const prefix = invoiceNumberPrefixFor(kind); ... }
```

A purchase therefore prints `SUP-NNNN`. `#268` (`bbdd005`) is an ancestor of both
`da5f336` and `e3094de`.

## 2. Failing first — `da5f336-pre-fix-e2e-red.log`

```
command: DOKAN_PORT=4700 DOKAN_WEB_PORT=5700 DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701 \
         npx playwright test tests/e2e/purchase-inline-product.spec.ts
exit:    1  (2 failed / 0 passed)
:94:59   expect(locator).toContainText(expected) failed — Expected substring "INV-",
         Received string "تم حفظ الفاتورة رقم SUP-0001"
:182:59  same — Received string "تم حفظ الفاتورة رقم SUP-0002"
```

Red for the right reason: the spec asserted the pre-#268 shape against a tree
that carries #268.

## 3. Green — `e3094de-pre-commit-e2e-green.log`

```
command: same ports, npx playwright test tests/e2e/purchase-inline-product.spec.ts \
         tests/e2e/purchase-intake.spec.ts tests/e2e/supplier-account.spec.ts \
         tests/e2e/supplier-adjustment.spec.ts tests/e2e/stock-ledger.spec.ts
exit:    0  (18 passed, 3.7m)
includes: purchase-inline-product.spec.ts:14 (10.6s) and :126 (6.3s) — both ok
```

## 4. Full suite — `e3094de-full-e2e.log`

```
command: same ports, npx playwright test        (whole tests/e2e/ suite)
exit:    0  (96 passed, 13.4m; no failures, no flakes)
```

Run because `scripts/e2e-selection.ts` classifies a changed spec file as a
critical path (`mode=full`), so PR #266's CI e2e job runs the whole suite; the
local full run is that job's answer on this tree.

## 5. Ablations — the assertion bites — `run-257-round3.ts`

Harness: `.scratch/ablation/run-257-round3.ts` (patch → run the one spec →
restore; no `git stash`). 2/2 mutants red, every file restored
(`git diff` clean afterwards apart from the fix itself).

| id | mutation | result | received |
|---|---|---|---|
| A1 | `formatDocumentNumber` returns the digits only — the number loses its prefix entirely | **RED** (`e3094de-ablation-A1.log`, 2 failed) | `0001`, `0002` |
| A2 | `invoiceNumberPrefixes.PURCHASE: "SUP"` → `"INV"` | **RED** (`e3094de-ablation-A2.log`, 2 failed) | `INV-0001`, `INV-0002` |

A1 is the criterion "the spec would still fail if the purchase number lost its
prefix entirely"; A2 proves it names *this* kind's prefix, not any three letters.

## 6. Gates

| Command | Exit | Evidence |
|---|---|---|
| `bun run typecheck` | 0 | `e3094de-typecheck.log` (4/4 turbo tasks) |
| `bun run lint` | 0 | `e3094de-lint.log` (oxlint, no findings) |
| `bun test scripts/e2e-selection.test.ts scripts/sync-claude-skills.test.ts scripts/verification-rule.test.ts` | 0 | `e3094de-scripts-suite.log` (97 pass / 1 skip / 0 fail, 289 expects) |

`bun run test` (the whole unit suite) is **not** run: the harness heavy-run guard
refuses it ("no slot is free") because its slot-script path is mangled on Windows
(`D:projectsmani-project...`), the same blocker lanes #253, #249 and #244
recorded. The change touches only `tests/e2e/**`, which no unit suite imports;
the narrowed run above covers the one unit guard that reads this directory
(`scripts/e2e-selection.test.ts` — every spec on disk mapped to a rule).

## 7. Does the merge change any other expectation? (the required statement)

Search: `git grep -n "INV-" da5f336 -- tests/e2e` → **36 lines** at the pre-fix
tree = 30 non-comment + 6 comments.

- 2 purchase assertions + 1 stale comment: fixed (`purchase-inline-product.spec.ts:94,182`,
  `supplier-adjustment.spec.ts:101`).
- 33 sale-path lines (a sale keeps `INV-`): `sale-saved-number`,
  `receipts.spec.ts:92` sale receipt, `debts.spec.ts:120` the customer's unpaid
  **sale** invoices, `customers.spec.ts:246,306`, `returns.spec.ts`,
  `sale-checkout.spec.ts`, `00-onboarding.spec.ts`,
  `96-returns-supplier-action.spec.ts`, `completion-screens.spec.ts`,
  `expense-reports.spec.ts`, `invoice-payments.spec.ts`, `learnability.spec.ts`.
- `rg -n "RTN-" tests/e2e/` → **no hits** (#268 converted the customer-return
  ones to `RET-`); the surviving return assertions are `/RET-\d+/`
  (`completion-screens.spec.ts:58,71`, `returns.spec.ts:86,207`), and supplier
  returns keep `PRT-` in SQL (`drizzle-store.ts:2192`), untouched by #268.

After the fix the same grep returns 34 lines: the 33 sale-path ones plus the new
explanatory comment at `purchase-inline-product.spec.ts:95`.

## 8. Decisions

1. Continued the PR branch (`a6838f0`) and merged `origin/develop` (`03d1878`)
   rather than rebasing: those SHAs are already pushed to PR #266, and the fix is
   only meaningful on a tree that carries #268.
2. `toContainText(/SUP-\d+/)` over `toContainText("SUP-")`: "SUP-" alone passes on
   a card that prints the prefix with no number, which the brief's criterion
   forbids.
3. Fixed the stale comment in `supplier-adjustment.spec.ts:101`: same merge's
   leftover, purchase path, and #268 fixed the identical comment in
   `supplier-account.spec.ts:53` — leaving one behind would be an inconsistency.
4. Kept the fix to two assertion lines + one comment; the review's Duplicated
   Code / helper-extraction suggestion is recorded in `e3094de-code-review.md` as
   a deliberate non-action (it would rewrite sibling specs outside this lane).

## 9. Review gates

- Test audit: `.scratch/reviews/257/e3094de-test-audit.md` — grade A-, no blocker;
  its one orange finding (no `RET-` e2e assertion) was **refuted with line
  evidence** and recorded as such.
- Code review (Standards + Spec, two independent read-only sub-agents):
  `.scratch/reviews/257/e3094de-code-review.md`, axes captured verbatim in
  `e3094de-standards.md` and `e3094de-spec.md`. Both ran no tests; their
  findings were reproduced in-lane above.
