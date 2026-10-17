# #255 round 4 — verification evidence (head 8e3f6c6)

Continues the rescued work `5039a4e`, rebased onto the PR head `12e258da` and
squashed with the audit fixes. Tier: standard. Design: `.scratch/implementation/255-round3-design.md`.

Every red below is the guard under test mutated, run, and reverted. `git checkout --`
restored the file between runs; the mutations are not in this commit.

## Finding 1 — r4302427456 "Extra requests pass the test"

**Already closed at `12e258da`** (same discussion id). Re-verified rather than
trusted, by restoring the rescue's duplicate `save` (the bug this lane deleted):

```
DOKAN_PORT=4800 DOKAN_WEB_PORT=5800 DOKAN_VAULT_PORT=4801 DOKAN_VAULT_WEB_PORT=5801 \
  bun run test:e2e -- tests/e2e/supplier-adjustment.spec.ts -g "agree with the invoice" --reporter=line
exit 1 @ tests/e2e/supplier-adjustment.spec.ts:154:27
  expect(openingRequests).toHaveLength(1)
  Expected length: 1 / Received length: 2
  Received array: ["http://127.0.0.1:5800/api/rpc/suppliersOpeningBalances", ... twice]
```

Green with the duplicate removed: full spec `10 passed (1.4m)`, exit 0.

## Finding 2 — r4303145122 "Empty names escape duplicate checks"

Gate: `newOpeningRowStatus` now compares the fold key (`normalizeTextKey(name)`),
not the raw trimmed name.

| Mutation (revert just this guard) | Command | Observed red |
| --- | --- | --- |
| `folded === ""` → `name === ""` in `supplier-opening-draft.ts` | `cd apps/web && bun test src/lib/supplier-opening-draft.test.ts -t "refuses a name that folds to no identity"` | exit 1 @ line 96: `- "status": "incomplete"` / `+ "status": "filled", "name": "<RLM>", "amount": 800` |
| same | `bun test src/pages/supplier-opening-balance.test.tsx -t "blocks a typed row whose name folds to no identity"` | exit 1 @ line 2154: `expect(rowError?.textContent ?? "").toContain("أكمل")` / `Received: ""` |

Real user pace (images + video beside this file): a Playwright spec filled
U+200F + 800 on the running page and read the settled row state.

| | save | row error | blocked banner |
| --- | --- | --- | --- |
| BEFORE (`finding2-before-*`) | enabled, «حفظ تسوية واحدة» | none | none |
| AFTER (`finding2-after-*`) | disabled, «حفظ 0 تسوية» | «أكمل اسم المورّد الجديد ومبلغه» | same |

## Finding 3 — r4303145134 "Large saves repeat full reads"

| Mutation | Command | Observed red |
| --- | --- | --- |
| Page calls the batch once per row (same endpoint) | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx -t "resolves the whole typed batch in ONE lookup"` | exit 1 @ line 2182: `expect(resolveCalls).toBe(1)` Expected 1 / Received 4 |
| `foldSupplierCandidates` moved inside the per-row loop in `router.ts` | `cd apps/api && bun test src/rpc/router.test.ts -t "reads the two lean lists once for the whole batch"` | exit 1 @ line 2589: `expect(reads).toHaveLength(2)` Expected 2 / Received 8 |

The cost pin is paired with the existing `listPartyNames` shape pin in
`drizzle-store.test.ts`, so the replacement read cannot carry an aggregate field
(wisdom `2026-10-15-cost-pin-proves-the-call-not-the-query`).

## Finding 4 — r4303145141 "Mixed confirmation answers lack coverage"

| Mutation | Command | Observed red |
| --- | --- | --- |
| Cross the per-row answers: `result.suppliers[len - 1 - index]` | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx -t "keeps each row's own destination and confirmation answer"` | exit 1 @ line 2215: `- "confirmExisting": true` / `+ undefined`; `- "expectedSupplierId": "s-1"` / `+ null` |

## Gates on 8e3f6c6

| Gate | Result |
| --- | --- |
| `bun run typecheck` | exit 0, 4 tasks successful |
| `bun run lint` | exit 0 |
| `tests/e2e/supplier-adjustment.spec.ts` | 10 passed (1.4m), exit 0 |
| `bun run test` (no other heavy run) | exit 0 — api 938 pass / 0 fail, web 1298 pass / 0 fail, root scripts 73 pass / 0 fail, 4 tasks successful |
| `bun audit --audit-level=high` | "No vulnerabilities found (checked 315 packages)", exit 0 |

Two earlier full-suite runs failed one `@dokan/api` vault/session-secret test (a
two-process convergence test) while another lane held the second e2e slot. That
file is 11 pass / 0 fail in isolation and the api package alone is 938 pass /
0 fail, so it is load flake, not this diff.

## Ablation honesty

- Finding 3's web mutation keeps the same endpoint and only changes the call
  count, so the pin cannot be evaded by renaming the seam
  (wisdom `2026-10-16-abandoned-branch-is-a-source-not-a-review`).
- Finding 4's mutation isolates the per-row mapping in one expression; the first
  mutant tried (per-row split) also crossed the answers but changed two things at
  once, so it was replaced with the single-expression cross.
- Finding 1's red is a real duplicate write, not a synthetic counter.
- Finding 2 has no unit-level ablation for the *page* render beyond the test
  above: the page test asserts the rendered row error and the disabled Save, and
  the real-page run reads the same state, so the DOM path is covered.
