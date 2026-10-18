# #254 — rebase PR #263 onto `origin/develop`: evidence

Standing evidence rule (#259). This change is **not visual** (a rebase whose settled behaviour must
not move), so the evidence is the measurements below: the rebase command, the conflicted files and
which side each hunk came from, the `git patch-id --stable` table, the per-file blob table, the
invariants asserted on the rebased tree, and the gates. The brief for this lane says a
red-then-green run is not the point of a rebase; where the rebase did surface genuine red it is
recorded below, with the failing assertion named.

Tier: **Standard** — a rebase plus verification; it can move money *rendering* but computes no
total, signs no balance and touches no store, so none of the five High-assurance failure modes is
in play. The sign convention it must not regress is pinned by develop's own #260 tests.

## 1. The rebase

```bash
git fetch origin --prune
git reset --hard origin/fix-254-money-display   # 57a2b32, the real PR head (NOT the stale local ref a8cb27f)
GIT_EDITOR=true git rebase origin/develop       # cb5cb5c
```

| | SHA | commits |
|---|---|---|
| base | `origin/develop` = `cb5cb5c` | #258/#268, #259/#261, #253/#265, #255/#264, #260/#271 |
| pre-rebase tip | `57a2b32` | 6 (#254) |
| rebased tip | `15179d9` | 6, all rewritten |
| tested head | `599b6fc` | + 1 test-expectation commit (§5) |

`git merge-base --is-ancestor origin/develop HEAD` → **exit 0 (true)**.
`git merge-base HEAD origin/fix-254-money-display` = `d843566` (the PR's own merge-base).
`CURRENT_SCHEMA_VERSION = 5` (unchanged; #271 moved 4 → 5 and the rebase does not reintroduce 4).

Conflicted files — four hunks, all inside the first four replayed commits:

| replay | commit (pre → post) | conflicted files |
|---|---|---|
| 1/6 | `a6a6890` → `c6787fc` | `apps/web/src/pages/debts.tsx`, `apps/web/src/pages/party-detail.tsx` |
| 4/6 | `79d8c53` → `efb33cb` | `apps/web/src/pages/activity.tsx`, `apps/web/src/pages/activity.test.tsx` |

`apps/web/src/lib/i18n.ts` **auto-merged** in 4/6: develop's new keys
(`activitySupplierAdjustment`, `activitySupplierOpeningBalance`, five `activityVault*`) and the
branch's `<money/>`-tagged strings touch different lines. #271's only i18n edit is the two
direction-label *values* (`supplierAdjustDirectionWeOwe`/`TheyOwe`), which the money strings do not
reference.

## 2. Which side each conflict hunk came from, and why both survive

### `debts.tsx` — the supplier row total

| side | text |
|---|---|
| develop (#271) | `netBalance = row.accountBalance ?? -row.remainingTotal`; `netBalanceClass`; `netBalanceSign = "+ " / "− "`; renders `{netBalanceSign}<Amount value={Math.abs(displayAmount)} />` |
| branch (#254) | renders `<Amount value={Math.abs(displayAmount)} sign={netBalance !== null && netBalance < 0 ? "−" : undefined} />` with the old colour test |

Resolution: keep develop's **semantics** (`?? -row.remainingTotal`, `netBalanceClass`, the
positive-is-credit mapping) and route the sign through the primitive as
`sign={netBalanceSign}` with `netBalanceSign: "+" | "−" | undefined`. The branch's colour test is
dropped because #271 owns the colour, and the branch's *sign-inside-the-isolate* is kept because
that is #254's whole point.

### `party-detail.tsx` — one supplier-account row

| side | text |
|---|---|
| develop (#271) | `<td className={... sign === "+" ? "text-success" : "text-destructive"}>{sign} <Amount value={entry.amount} /></td>` |
| branch (#254) | `<td className="p-2 font-medium"><Amount value={entry.amount} sign={sign} /></td>` |

Resolution: develop's colour class **plus** the branch's primitive routing. `textContent` is
byte-identical either way; only the bidi grouping moves (the sibling sign is what #254 measured at
the far end of the row).

`SupplierBalanceHeader` did **not** conflict: the branch never edited it, so #271's flipped
reader (`owed = balance <= 0`, red `< 0`, green `> 0`) applies cleanly.

### `activity.tsx` — supplier/vault speech

| side | text |
|---|---|
| develop | the three pre-money one-liners on `t()` **plus** the #253 additions (two supplier-account arms, five `VAULT_*` arms) |
| branch | the same three supplier tags rewritten as `<Trans>` + `<Amount>` |

Resolution: the branch's three `<Trans>` arms **plus** develop's new arms, character-for-character.
On the three shared tags the branch's version is the only correct one — the auto-merged i18n strings
are `<money/>`-tagged (`"دفعة إلى مورّد <money/> — {{name}}"`), so develop's `t()` form would print
the literal `<money/>`. develop's two new arms stay on `t()` with the raw `{{amount}}` token: they
are develop's rows, their strings carry no `<money/>` tag, and develop's own tests assert the
returned string.

### `activity.test.tsx` — imports and the fixture list

Resolution: develop's typed `Case[]` (each row carries its `tag`, and the list is pinned to the
server's `activitySummaryTags` vocabulary by the coverage test) **with the branch's grouped-money
expectations** on the four money rows (`5000`→`5,000`, `3000`→`3,000`, two `2000`→`2,000`), plus the
branch's `ReactNode`/`act`/`createRoot` render helper and the `IS_REACT_ACT_ENVIRONMENT` flag. The
branch's extra `EXPENSE_CATEGORY_CREATED NORMAL` row is dropped: develop's own
"distinguishes a withdrawal expense category from an ordinary one" test makes the same assertions,
and the coverage test rejects a duplicate tag.

Machine check that both sides survive:

| symbol (develop side) | count in resolved `activity.tsx` |
|---|---|
| `activitySupplierAdjustment` / `activitySupplierOpeningBalance` | 1 / 1 |
| `VAULT_SETUP_RESUME_FAILED` / `VAULT_RECOVERY_RESET_FAILED` | 1 / 1 |

| symbol (branch side) | count in resolved `activity.tsx` |
|---|---|
| `<Trans` | 10 |
| `components={{ money: <Amount` | 9 |

## 3. `git patch-id --stable` — 4 of 6 commits byte-identical

| old commit | new commit | old patch-id | new patch-id | identical |
|---|---|---|---|---|
| `a6a6890` | `c6787fc` | `4903b77a08d0` | `adaf6c78dea6` | **no** |
| `a30e9ee` | `b155cd1` | `5eb736394ba8` | `5eb736394ba8` | yes |
| `a8cb27f` | `9d498c7` | `6fae20db36ef` | `6fae20db36ef` | yes |
| `79d8c53` | `efb33cb` | `2b740072e35b` | `a13cdd2ec1bc` | **no** |
| `788503b` | `3ca8dfb` | `6c1ccb7a0866` | `6c1ccb7a0866` | yes |
| `57a2b32` | `15179d9` | `948b2e169cee` | `948b2e169cee` | yes |

The two `no` rows are exactly the two replayed commits that hit conflicts (1/6 and 4/6). Round 2 and
round 3 are not reverted: `788503b` (round 3, "the money unit is one atomic wrapper") is
byte-identical, and `79d8c53` (round 2) differs only by the documented §2 union.

## 4. Per-file blobs at the pre-rebase tip vs the rebased tip

60 files changed by the PR. **43 are byte-identical** (including every PR-only file:
`components/ui/amount.tsx`, `components/ui/amount.test.tsx`, `lib/money-format.ts`,
`lib/money-format.test.ts`, `tests/e2e/money-display-helpers.ts`, `components/print-sheet.tsx`).
The 17 that differ are the files develop also touched; every one of them differs from develop's own
tip, i.e. it is a **union**, not a takeover:

```
apps/web/src/components/parties/supplier-adjust-panel.test.tsx   union (PR + develop)
apps/web/src/components/parties/supplier-pay-panel.test.tsx      union (PR + develop)
apps/web/src/lib/i18n.ts                                         union (PR + develop)
apps/web/src/pages/activity.test.tsx                             union (PR + develop)
apps/web/src/pages/activity.tsx                                  union (PR + develop)
apps/web/src/pages/dashboard.test.tsx                            union (PR + develop)
apps/web/src/pages/debts.test.tsx                                union (PR + develop)
apps/web/src/pages/debts.tsx                                     union (PR + develop)
apps/web/src/pages/party-detail.test.tsx                         union (PR + develop)
apps/web/src/pages/party-detail.tsx                              union (PR + develop)
tests/e2e/customers.spec.ts                                      union (PR + develop)
tests/e2e/debts.spec.ts                                          union (PR + develop)
tests/e2e/purchase-intake.spec.ts                                union (PR + develop)
tests/e2e/supplier-account.spec.ts                               union (PR + develop)
tests/e2e/supplier-adjustment.spec.ts                            union (PR + develop)
```

(`lib/print-format.ts` / `lib/print-format.test.ts` are *deleted* by the PR; they show as `MISSING`
on both sides.)

## 5. The PR's settled invariants, asserted on the rebased tree

| invariant | proof | result |
|---|---|---|
| one grouped money primitive | `components/ui/amount.tsx` byte-identical to `57a2b32` | identical |
| currency left of the number, bidi-isolated | same blob + `tests/e2e/supplier-adjustment.spec.ts:615` ("the removed-row amount keeps its currency beside its digits in a narrow row") | identical, e2e pass |
| `<Trans>` + `<Amount>` for translated money | `activity.tsx` keeps all 9 `components={{ money: <Amount … }}`; the catalog guard scans `lib/i18n.ts` for a value carrying `دج` beside a `{{placeholder}}` | pass, `offenders === []` |
| empty catalog-guard allow-list | `amount.test.tsx` → `expect(offenders).toEqual([])`, with its non-vacuous half (the detector fires on a planted line first) | pass, allow-list empty |

Failing-first, and it is a real red: four assertions are *semantically* stale after #271 + #254
grouping. They failed on the rebased tree before `599b6fc`:

| assertion | expected | received |
|---|---|---|
| `party-detail.test.tsx:879` `toContain("1000")` | `1000` | `1,000 دج` |
| `supplier-opening-balance.test.tsx:443` `toContain("5000")` | `5000` | `5,000 دج نسالوه` |
| `debts.spec.ts:125` `toHaveText("1,200")` | `1,200` | `− 1,200` |
| `supplier-adjustment.spec.ts:241` `toHaveText("− 100,000")` | `− 100,000` | `+ 100,000` |

Ablations (each mutation applied alone on the rebased tree, then reverted — the guard bites):

| mutation | failures |
|---|---|
| A1 render the debts sign as a **sibling** text node | #254 test: Expected `+ 92,500 دج`, received `+92,500 دج` |
| A2 restore the **pre-#271 polarity** mapping | #254 test (received `92,500 دج`) **and** develop's #260 test (expected to contain `+`, received `1,500 دج`) |
| A3 drop develop's `SUPPLIER_ADJUSTMENT`/`OPENING_BALANCE` arm | 4 failures, the raw tag leaks (`SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد بن علي`) |

## 6. Gates on the rebased tree

| command | result | exit |
|---|---|---|
| `bun run typecheck` | 4/4 tasks | 0 |
| `bun run lint` (oxlint) | clean | 0 |
| `bun run test` (turbo) | 4/4 tasks; web **1362 pass / 0 fail**, api + desktop + e2e-support + scripts green | 0 |
| `bun run test:e2e` (full Playwright suite) | **95 passed** (10.2m) | 0 |

The e2e run held slot 1 of the shared cap (`e2e-slot.sh`; quartet `DOKAN_PORT=4700`,
`DOKAN_WEB_PORT=5700`, vault 4701/5701) and was released afterwards. In the first narrowed run
(9 PR-touched specs) `supplier-account.spec.ts` failed on a `getByRole('option')` timeout with
`Protocol error … session closed`; it passed in isolation (12.5s) and in the full suite, i.e. the
stale-server/resource class of
`.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md`, not a regression.

## 7. Decisions taken, with the reason

1. **#260's polarity is authoritative; the PR's screenshots are stale.** The four red assertions
   above are reread to the merged convention in `599b6fc` (test expectations only). The PR's
   screenshots under `.scratch/reviews/254/` were recorded against the **old** polarity, so their
   visible sign is wrong for the rebased tree. They are **not** re-recorded here; the parent decides
   whether a fresh capture is needed before merge.
2. **`debts.tsx` keeps develop's `?? -row.remainingTotal` fallback and colour, and gains the
   primitive sign** — the union of both intents, not a choice between them.
3. **`party-detail.tsx` keeps develop's colour class and routes the sign through `<Amount>`.**
4. **`activity.tsx` keeps both sides' arms**; the three shared tags use `<Trans>` because the
   catalog carries `<money/>` (a `t()` call would print the tag literally).
5. **`activity.test.tsx` keeps develop's typed `Case[]`** (the tag-coverage pin) with the branch's
   grouped expectations; the branch's duplicate `EXPENSE_CATEGORY_CREATED NORMAL` row is dropped.
6. **The four stale assertions are a separate commit, not an amend.** #271 set the precedent
   ("reread the #252 label flip in two develop-era tests"); the repo squash-merges, so history
   stays clean and the rebase commits keep their own shape.

## 8. Wisdom applied

- `2026-08-25-report-windows-and-rebase.md` — additive conflicts, `GIT_EDITOR=true`, re-run
  typecheck + the full battery after the surgery rather than before.
- `2026-10-16-abandoned-branch-is-a-source-not-a-review.md` — `57a2b32` is treated as a diff source
  rebased onto `cb5cb5c`; its old verdict is not inherited, every gate is re-run.
- `2026-10-13-supplier-adjustments-and-schema-bump.md` — a sign change is a format change: the
  schema version is quoted (5) and the flipped `supplierEntrySign` is develop's, not the branch's.
- `2026-10-01-rtl-dates-bidi-and-align.md` — bidi is verified in a real browser; the sign-inside-the-
  isolate assertion is an e2e geometry check, not a `textContent` check.
- `2026-10-13-e2e-stale-server-and-checksum-flake.md` — an isolated pass / suite fail is a
  stale-server smell first; `supplier-account.spec.ts` was re-run in isolation before touching it.
- `2026-10-15-concurrent-lane-e2e-ports.md` — the e2e run took a slot and used the disjoint port
  quartet rather than the shared 4317/5173.

Not applied: `2026-10-15-display-vs-recording-order.md` and the ledger-display lessons — this lane
merges two renderings of the same activity rows, there is no recording-order question, and applying
one would mean inventing a behaviour change.

## 9. Reproduce

```bash
git fetch origin --prune
git reset --hard origin/fix-254-money-display   # 57a2b32
GIT_EDITOR=true git rebase origin/develop       # four conflicts, as in §1
git merge-base --is-ancestor origin/develop HEAD && echo mergeable
cd apps/web && bun test --max-concurrency=2
cd .. && bun run test:e2e
```
