# #227 — Test-audit evidence

- Base: `origin/develop` @ `6708324` (PR #229/#210 and #225 merged).
- Reviewed HEAD: `e472d5b`.
- Method: three independent auditors (edge-case hunter, coverage analyst, quality
  reviewer) as separate sub-agents, on a read-only checkout. The parent reproduced
  every multi-run claim and the mutation counts.
- Reviewed delta: `git diff origin/develop...HEAD` (7 paths: the mark strip and
  its pins, plus `.scratch/implementation/227-design.md`).

## Final grades

| Test file | Grade | Note |
|---|---|---|
| `apps/web/src/lib/amount-parse.test.ts` | A | Ten-mark loop (not a sample), both strip boundaries, edge/interior both ways, ASCII identity. |
| `apps/web/src/lib/invoice-draft.test.ts` | A− | Mark-only override regression pin bites (caught by mutation C); `nextUnitCost` value change pinned and documented. |
| `apps/web/src/lib/numeric-input.test.ts` | B+ | The #225-routed readers are now pinned (edge/interior/mark-only); `parseSignedWholeNumber`'s pre-normalisation sign check pinned as a safe refusal. |
| `tests/e2e/sale-checkout.spec.ts` | B+ | Paste-shaped, and the `toHaveValue(\u200f…)` assertion stops it passing by pre-normalising; ~30 lines of setup duplicated from the #210 spec (file-wide pattern). |

## Mutation evidence (parent-run; source reverted immediately, `git status` clean after)

Applied to the production source, ran the three unit suites, reverted:

| Mutation | Result |
|---|---|
| No-op the strip (`return stripEdgeBidiMarks(draft)` → `return draft`) | **11 of 96 fail** — every #227 pin that depends on an edge mark being dropped. |
| Strip *all* marks (no edge/interior distinction) | **4 fail** — the interior-refusal pins in `parseWholeAmount`, `parseGroupedAmount`, `numeric-input` and the `nextUnitCost` interior pin. |
| Revert `draftBlank` to the raw `.trim()` guard | **1 fail** — `treats a mark-only override as «nothing chosen», never a free line (#227)`. |

Pre-fix (base `6708324`, no strip): `parseWholeAmount("\u200f٥")` = `null`,
`parseWholePercentage("\u200f١٠٠")` = `null`, `parseLooseNumber("\u200f")` = `NaN`
— the ticket's exact reproduction, so the leading-mark pins genuinely discriminate.

The delta since the last reviewed SHA (`258a81c`) is test pins + a header comment
+ design wording; the previous mutation counts (10 / 3 / 1) were the pre-delta
tree, and the final commit's numeric-input pin is the additional failure under
mutations A and B.

## Findings actioned

1. **Coverage gap (Medium): the #225-routed `numeric-input.ts` readers were listed as affected but unpinned.** Fixed: `numeric-input.test.ts` now pins `parseWholeNumber` (edge, interior, mark-only), `parseSignedWholeNumber` (an edge mark before the sign is a safe refusal), and `resolveOpeningStock`.
2. **BOM/override/ZWSP boundaries** pinned as untouched so a future widening fails.
3. **Interior marks refused** — pinned both as reader refusals and, via `nextUnitCost`, as keep-previous.

## Remaining gaps (accepted, low)

- Interior-refusal coverage is uneven across readers (`parseWholePercentage`,
  `parseLooseNumber`, `parseQuantityDraft` pin edge/blank but not a direct
  interior refusal). A reader-specific interior regression is not reachable
  because every reader goes through the one normalizer, and the interior rule is
  pinned through sibling readers.
- `parseReturnQuantities` / `parseCashBackDraft` / `saleDebt` mark-only refusals
  are audited in prose, not pinned. Refusal only; no wrong-number path.
- e2e was verified by inspection by the auditors; the parent ran it (5 passed).
- Self-comparing ASCII-identity assertions (`toBe(f(bare))`) sit beside a literal
  anchor in the same test, so no discrimination is lost.

## Commands at `e472d5b`

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 (4/4 turbo tasks) |
| `bun run lint` | exit 0 (oxlint, no output) |
| `bun run test` | exit 0 — `@dokan/web` 1133 pass / 0 fail; api 934; desktop 68; e2e-support 22; scripts 38 pass / 1 skip / 0 fail |
| `bun run test:e2e tests/e2e/sale-checkout.spec.ts` | exit 0, 5 passed (lane ports `DOKAN_PORT=4417 DOKAN_WEB_PORT=5273`) |
| touched unit suites | 96 pass / 0 fail / 521 expect |
