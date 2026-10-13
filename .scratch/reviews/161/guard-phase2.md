# Guard — issue #161, Greptile round-1 fix commit

## Phase 1 — pre-commit (Husky `oxlint` hook ran on the commit)

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 workspaces pass |
| lint | `bun run lint` | 0 errors |
| unit + store tests | `bun run test` | api 751 pass / 0 fail; web 757 pass / 0 fail |

## Phase 2 — pre-push (HEAD `86bd4935c6d7aa2388b419611d7e32b4d92ba72d`)

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 pass |
| lint | `bun run lint` | 0 errors |
| tests | `bun run test` | api 751 pass; web 757 pass; 0 fail |
| e2e (UI changed) | `bun run test:e2e` | 51 passed (2.9m) |
| working tree | `git status --short` | only `.scratch/` evidence (non-reviewable) |
| evidence | `.scratch/reviews/161/<sha>-{debate,test-audit,code-review}.md` | present for `86bd493`; older round archived under `superseded/` |

## Review evidence

- Reviewed implementation SHA: `86bd4935c6d7aa2388b419611d7e32b4d92ba72d`
- Debate: no blocker; two additive coverage follow-ups (v1→v2 migration test,
  server-side zero-value invoice-linked return test).
- Test-audit: all 8 Greptile findings have a regression test that fails without
  its fix; the global-history render of the supplier name is covered by the
  store join + voucher tests.
- Code-review: all 8 findings fixed; non-goals and do-not-touch respected.

## Greptile round-1 findings → fix

1. schema-version bump to 2 (+ refusal test) — `apps/api/src/lib/schema-version.ts`
2. zero-amount purchase skips the charge entry — `apps/api/src/rpc/router.ts`
3. return draft validation rejects, never drops — `supplier-return-panel.tsx` + `supplier-return-draft.ts`
4. pay preview passes the full amount — `supplier-pay-panel.tsx`
5. free-standing voucher omits the stock cost as unit price — `supplier-return-print.tsx`
6. voucher + history name the supplier — `drizzle-store.ts` join, `core.ts`, `returns.tsx`
7. Arabic activity cases — `activity.tsx` + `i18n.ts`
8. free-goods invoice-linked return submits on valid quantities — `supplier-return-panel.tsx`

## Deferred (non-blocking, additive coverage)

- v1→v2 forward-migration test.
- Server-side test for a zero-value invoice-linked return (safe by `> 0` guards today).
