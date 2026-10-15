# Evidence — #198 at `cb01879bd371b898b5280eec58ee5c8c84f22794`

- **Issue:** #198 — invoice-draft: extract the ordering invariant, close the
  test gaps (#146 follow-up).
- **Tier:** High-assurance (checkout money path).
- **Base (post-rebase):** `origin/develop` @
  `3c3abcfcdc4773a50a94ad5029a5fc541253d46a` (#184, #196 landed).
- **Original base:** `21dbc13f13d1889646f4466e610decf5a077253b`.
- **Reviewed code HEAD:** `cb01879bd371b898b5280eec58ee5c8c84f22794`.
- **Branch:** `feat-198-draft-ordering` (local, not pushed).
- **Design:** `.scratch/implementation/198-design.md`.

## Rebase

`git fetch origin develop && git rebase origin/develop` from the pre-rebase head
`5d0e9bd`-equivalents onto `3c3abcf`. **Clean — no conflicts.** The parent's
overlap check held: this branch touches only web (`amount-parse`,
`invoice-draft`, `sale`, `purchase`) plus tests; develop's new work was api
(`opening-balance-resolver`, router) and the supplier-opening-balance/i18n web
surfaces. `git diff --stat 3c3abcf...HEAD` shows only this branch's files.

Pre-rebase reviewed SHAs (`663fb71`/`cb6e0a3`/`04b6886`/`699483d`) were rewritten
by the rebase; the new equivalents are below. Gates and evidence were
regenerated at the new SHAs.

## Commits (rebased)

| sha | subject |
|---|---|
| `65920c4` | refactor(web): one commit order for the invoice-draft screens (#198) |
| `236fecd` | fix(web): apply #198 debate findings to the commit-order extraction |
| `f3b21eb` | test(web): close the #198 test-audit gaps |
| `cb01879` | refactor(web): apply #198 code-review findings ← reviewed code |
| `c8115d4` | docs(wisdom): an extracted check order needs a loud guard beside its helper (#198) |
| `a5d3c04` | docs(reviews): #198 debate, test-audit, code-review and guard evidence |
| `5d0e9bd` | docs(reviews): name the #198 evidence for the final head |

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
 .scratch/reviews/198/*
 .agents/wisdom/2026-10-15-extraction-ordering-guard.md
```

No server, contract, or schema change.

## Guard Phase 1 — pre-commit (rebased tree)

| command | result |
|---|---|
| `bun run typecheck` | exit 0 (3 successful) |
| `bun run lint` | exit 0, 0 errors |
| `bun run test` | exit 0 — **1007 web tests, 0 fail** (5219 expect() calls) |

Rust not touched, so no cargo step.

## Guard Phase 2 — pre-push (rebased tree)

| command | result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 — 1007 web tests, 0 fail |
| `bun run test:e2e` | **70 passed, 0 failed** |
| working tree | clean of source changes |

E2E ran on an isolated pair with all four ports set as the brief requires:
`DOKAN_PORT=4621 DOKAN_WEB_PORT=5481 DOKAN_VAULT_PORT=4622
DOKAN_VAULT_WEB_PORT=5482 bun run test:e2e`.

### Flake note (contention with three sibling lanes)

The first full run on the rebased tree was 67 passed / 2 failed / 1 not run:

- `learnability.spec.ts` "the checkout bar stays pinned while a long invoice
  scrolls"
- `vault.spec.ts:183` "first run: passphrase → recovery key shown once → …"

Both passed in isolation on the same pair immediately after:

- `bunx playwright test tests/e2e/learnability.spec.ts` → 7 passed
- `bunx playwright test tests/e2e/vault.spec.ts` → 3 passed

A second full run was fully green: **70 passed / 0 failed**. The failures were
contention from the three concurrent sibling lanes (a different, timing- or
port-sensitive set each run), not this branch — the vault spec also reproduced
identically on the pristine base in the pre-rebase investigation.

The generated `.dokan-port` marker (written by the e2e API at boot) is restored
to its committed value `4317`; it is not part of the change.

## Issue asks

1. **Ordering has one home.** `firstCommitError` in
   `apps/web/src/lib/invoice-draft.ts` owns
   empty cart → party → per-line (override before quantity) → discount →
   payment. `sale.tsx` and `purchase.tsx` supply predicates and their own copy.
   Behaviour, messages, and the payload are unchanged.
2. **Test gaps closed.** override-vs-payment page test (`sale.test.tsx`) and
   browser test (`sale-checkout.spec.ts`); quantity `1000000`/`1000001`
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
