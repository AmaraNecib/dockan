# Evidence — #198 at `699483d81c78ede312214fba040aca050ba0f02b`

- **Issue:** #198 — invoice-draft: extract the ordering invariant, close the
  test gaps (#146 follow-up).
- **Tier:** High-assurance (checkout money path).
- **Base:** `origin/develop` @ `21dbc13f13d1889646f4466e610decf5a077253b`.
- **Head (code):** `699483d81c78ede312214fba040aca050ba0f02b`.
- **Branch:** `feat-198-draft-ordering` (local, not pushed).
- **Design:** `.scratch/implementation/198-design.md`.

## Commits

| sha | subject |
|---|---|
| `663fb71` | refactor(web): one commit order for the invoice-draft screens (#198) |
| `cb6e0a3` | fix(web): apply #198 debate findings to the commit-order extraction |
| `04b6886` | test(web): close the #198 test-audit gaps |
| `699483d` | refactor(web): apply #198 code-review findings |

## Files changed vs base

```
 apps/web/src/lib/amount-parse.ts        (normalizeArabicIndicDigits)
 apps/web/src/lib/amount-parse.test.ts
 apps/web/src/lib/invoice-draft.ts       (firstCommitError, Check, resolvedInitialPaid, parseQuantityDraft)
 apps/web/src/lib/invoice-draft.test.ts
 apps/web/src/pages/sale.tsx
 apps/web/src/pages/sale.test.tsx
 apps/web/src/pages/purchase.tsx
 apps/web/src/pages/purchase.test.tsx
 tests/e2e/sale-checkout.spec.ts
 .scratch/implementation/198-design.md
```

No server, contract, or schema change.

## Guard Phase 1 — pre-commit (at head)

| command | result |
|---|---|
| `bun run typecheck` | pass (3 successful) |
| `bun run lint` | pass, 0 errors |
| `bun run test` | pass — 979 web tests, 0 fail, 5038 expect() calls |

Rust not touched, so no cargo step.

## Guard Phase 2 — pre-push (at head)

| command | result |
|---|---|
| `bun run typecheck` | pass |
| `bun run lint` | pass, 0 errors |
| `bun run test` | pass — 979 web tests, 0 fail |
| `bun run test:e2e` | **58 passed, 0 failed** (7.7m) |
| working tree | clean of source changes (see below) |

E2E ran with an isolated pair as the brief requires:
`DOKAN_PORT=4491 DOKAN_WEB_PORT=5291 DOKAN_VAULT_PORT=4492
DOKAN_VAULT_WEB_PORT=5292 bun run test:e2e`.

**Note on the vault spec.** Earlier full runs failed
`vault.spec.ts:183` (the create-vault POST hung). The same failure reproduced on
a pristine `21dbc13` worktree, so it was pre-existing/environmental (sibling
lanes active). On the final head with the machine quieter the spec passed, and
the final full run is 58/58.

The generated `.dokan-port` marker (written by the e2e API at boot) is restored
to its committed value `4317`; it is not part of the change.

## Issue asks

1. **Ordering has one home.** `firstCommitError` in
   `apps/web/src/lib/invoice-draft.ts` owns
   empty cart → party → per-line (override before quantity) → discount →
   payment. `sale.tsx` and `purchase.tsx` supply predicates and their own copy.
   Behaviour, messages, and the payload are unchanged.
2. **Test gaps closed.** override-vs-payment page test (`sale.test.tsx`) and
   browser test (`sale-checkout.spec.ts:82`); quantity `1000000`/`1000001`
   boundary on both pages; multi-line first-offender on both pages plus the lib
   order matrix in both directions.
3. **Arabic-Indic decision: yes.** Quantities accept Arabic-Indic and Extended
   Arabic-Indic digits via `normalizeArabicIndicDigits`, shared with the amount
   reader. Scoped deliberately to quantities: the sale override/discount readers
   and `parseWholePercentage` stay ASCII-only, so every `resolveInitialPaid`
   number is unchanged. The single reachable-value delta (`٥` billed 5 instead of
   refused) is pinned at lib and page level.

## Deferred items

- `parseWholeAmount` (supplier-return quantities, `supplier-return-draft.ts`,
  `supplier-return-panel.tsx`) still rejects Arabic-Indic digits, so the
  quantity/amount mismatch the issue names persists on the returns screen.
  Out of #198's scope: widening it changes a money input. Needs its own ticket.
- No browser-level Arabic-Indic quantity fill (page + lib pins only).
- `CommitChecks` slot combinations other than (both optional present) and (both
  absent) are unexercised; no caller uses them.

> Code frozen at `699483d`; `e601e70` adds this lane only a `.agents/wisdom/`
> note (no `apps/` change), so this evidence still describes the reviewed code.
