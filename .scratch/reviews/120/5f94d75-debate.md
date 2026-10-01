# Issue #120 — Integration-round debate evidence (post-rebase)

- **Reviewed integration HEAD:** `5c26a8a473cfab2a38a6b09d7dfbfb25580e539f`
- **Final code HEAD / this file:** `a8f02b9232616d31b3a7bf47286d1e4baef8b1cf`
- **Pre-rebase reviewed code:** `60573aff2bb896aac06ac84683924ec4b8d2e52b`
- **Rebased onto:** `origin/develop` @ `1d02f93` (#119 dates + deps + #122 CI); the first rebase was onto `a0b96718f747d94181fc2b257d7d0ff2963a50b3`
- **Earlier rounds:** `.scratch/reviews/120/5dbb678-debate.md`,
  `a4647f5-test-audit.md`, `4cda79c-debate.md`.

## What was reviewed

The full integration delta `git diff 60573af 5c26a8a` plus the final tree for the
four overlap files, after rebasing the 9-commit branch over #119 and the deps
lane. Conflicts occurred only in `apps/web/src/pages/sale.test.tsx` (resolved
keeping both lanes); `i18n.ts`, `sale.tsx` and `activity.tsx` auto-merged.

## Verdicts

- **Critic:** score **9/10**, no blocker. Ground-truth checks it established:
  `git merge-base 60573af a0b9671` = `8579fcf` (lanes cleanly separable);
  `a0b9671` is an ancestor of HEAD (deps lane retained by construction);
  conflict-marker sweep over `apps/ tests/ packages/` → zero hits; all 33 #120
  files still exist; `60573af..HEAD` touches no `apps/api` file.
  - Both intents verified file by file: i18n (#119 `saleQuickAdd`/optional
    `saleQuickStock`/`dateNow` + #120 party block, `saleQuickStockBtn` gone
    tree-wide), sale.tsx (single quick-add with focus-only stock field +
    PartyPicker/counterpartyId), activity.tsx (`formatDateTime` + party token
    summaries), sale.test.tsx (#119's 5 quick-add tests + #120's picker test,
    both mock surfaces in one `mock.module`).
  - No i18n duplicate keys; the named collision risk does not exist.
- **Integration test-audit:** all four checks PASS — #119's quick-add block is
  byte-for-byte identical to develop; #120's picker test intact and asserts
  `counterpartyId`; the party-detail date swap invalidates no existing
  assertion; no coverage lost (41 `it(` after vs 36 before, +5 from #119).
- **Spec/standards:** all eight #120 scope items hold on the final tree; #119's
  date standard is correctly applied on the party detail page (`formatDate` for
  the invoice date, `formatDateTime` for payment/created-at, all `dir="ltr"`
  wrappers and `TODO(dates)` markers removed); i18n has both blocks, no
  duplicates; no documented standard broken by the resolution.

## Findings and resolution

| Source | Finding | Decision |
|--------|---------|----------|
| Critic + audit (Low) | The party-detail date wiring had no cell-level assertion: a revert to raw values would keep the suite green | **Fixed at a8f02b9**: `parties.test.tsx` now asserts the invoice row renders `01/10/2026`, the payment row `01/10/2026 10:05`, and `party-created-at` `01/10/2026 10:00` |
| Critic | Rebase-side test delta: a defensive `await` added inside the option-click `act` | **Accepted**: strengthens the test |
| Audit | Reviewers did not execute the suites (static-only) | **Closed by the lane's own runs**: typecheck, lint, 466 web tests + API suites, and 38/38 e2e all green at the integration SHA |

No other findings; nothing deferred from this round.

## Gates at the final integration SHA

- `bun run typecheck` — 3/3 pass (`apps/web` re-verified directly: exit 0)
- `bun run lint` — 0 errors
- `bun run test` — 466 web tests + API suites pass
- `bun run test:e2e` — 38/38 pass (full suite, including #119's updated specs)
