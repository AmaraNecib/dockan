# #252 rebase onto `develop` after #264 — evidence

**Gate:** rebase + verification (brief `fix-252-direction-labels-rebase2`).
**Tier:** Standard. A rebase adds no new behaviour; the named failure mode it *could*
violate is direction (who owes whom), so the five invariants below are treated as
the gate, not a smoke check.

| | |
| --- | --- |
| PR branch before | `0ed6bf0` (`origin/fix-252-direction-labels`, PR #267 head, itself an earlier rebase onto `03d1878`) |
| old merge-base | `03d1878` |
| develop at rebase | `4ad7076` (#264, "add-row control on the opening-balance page") |
| rebased code HEAD | `d24e94b` (after the test-adaptation commit) |
| rebase command | `GIT_EDITOR=true git rebase origin/develop` with HEAD at `0ed6bf0` |
| conflicted files | **2** — `apps/web/src/pages/supplier-opening-balance.tsx`, `tests/e2e/supplier-adjustment.spec.ts`, both in commits 1/10 and 2/10 |
| ancestor check | `git merge-base --is-ancestor origin/develop HEAD` → **exit 0** |

Note: the local branch `fix-252-direction-labels` was stale at `83c5e7d`; the PR head
GitHub reports is `origin/fix-252-direction-labels` = `0ed6bf0`. The rebase targets
the PR head, otherwise it would drop the round-2/round-3 commits.

## Red before, green after

```
$ git merge-base --is-ancestor origin/develop HEAD     # pre-rebase, on 0ed6bf0
exit 1                                                 # CONFLICTING

$ git merge-tree --write-tree 0ed6bf0 origin/develop
CONFLICT (content): Merge conflict in apps/web/src/pages/supplier-opening-balance.tsx
CONFLICT (content): Merge conflict in tests/e2e/supplier-adjustment.spec.ts
exit 1

$ GIT_EDITOR=true git rebase origin/develop
...
CONFLICT (content): Merge conflict in apps/web/src/pages/supplier-opening-balance.tsx
CONFLICT (content): Merge conflict in tests/e2e/supplier-adjustment.spec.ts
Rebasing (1/10) error: could not apply 5ab17fc ... (#252)
# resolved; 2/10 conflicted again; resolved; 3/10..10/10 applied cleanly
Successfully rebased and updated refs/heads/fix-252-direction-labels-rebase2.

$ git merge-base --is-ancestor origin/develop HEAD     # post-rebase, on 6566c7b
exit 0                                                 # mergeable
```

Transcripts: `d24e94b-rebase-transcript.txt`, `d24e94b-rebase-continue.txt`.

## The conflicts: which side each hunk came from, and why both survive

**Commit 1/10** `a4e0153` — `fix(web,api): put each supplier-direction label on the value its hint describes (#252)`

1. `supplier-opening-balance.tsx` imports. HEAD (#264) adds `focusByTestId`;
   ours (#252) adds `supplierDirectionKey`. Disjoint additions, both used →
   **kept both**.
2. `supplier-opening-balance.tsx` new-row block. HEAD (#264) replaces the single
   `opening-balance-new` row with `typedRowEntries.map(...)`; ours (#252) adds
   `items={directionItems}` to that single row. This is a **supersede, not an
   addition**: ours references `newName` / `newDirection` / `newAmount`, which #264
   deleted, so keeping both would not typecheck and would re-introduce the row #264
   removed. Resolution: **keep #264's typed-row structure and re-apply #252's
   one-line intent** — `items={directionItems}` on the typed-row `Select`.
3. `tests/e2e/supplier-adjustment.spec.ts` step 3. HEAD (#264) tests three suppliers
   in one pass; ours (#252) edits the single row and asserts the direction trigger
   reads a Darija label, never `WE_OWE`. Resolution: **keep #264's test and add
   #252's three label assertions** against `opening-balance-typed-direction-0`.
4. `tests/e2e/supplier-adjustment.spec.ts` step 8 (credit supplier). HEAD (#264)
   uses `opening-balance-typed-*` and picks «يسالنا»; ours (#252) uses the removed
   `opening-balance-new-*` and picks «نسالوه». Resolution: **keep #264's typed
   testids, take #252's label «نسالوه»** — after the fix «نسالوه» is THEY_OWE, the
   credit direction the test needs.

**Commit 2/10** `9ed2f94` — `fix(web): make the direction label map the only reading, per round-1 review (#252)`

5. `supplier-opening-balance.tsx` imports: add `supplierBalanceDirectionKey` →
   **keep #264's `focusByTestId` + the combined import**.
6. `supplier-opening-balance.tsx` popup options: #252 renders both `SelectContent`
   lists from `directionItems`; #264's typed-row `SelectContent` still had the two
   hand-written `SelectItem`s. Resolution: **apply the map to the typed-row
   `SelectContent` too**, so the trigger and the popup read one map.

**Post-rebase adaptation** `d24e94b` — `fix(web): point the #252 direction tests at #264's typed-row control (#252)`

7. `supplier-opening-balance.test.tsx`: `opening-balance-new-*` →
   `opening-balance-typed-*`; `pickTypedDirection(1, "يسالنا")` → `"نسالوه"`.
8. `.scratch/reviews/252/direction-labels.evidence.spec.ts`: same testid update.

## The PR's own diff survived the rebase

`git patch-id --stable` of `git diff <base> <tip> -- <file>` before (`03d1878..0ed6bf0`)
vs after (`4ad7076..d24e94b`): **19 of 22 touched files byte-identical**. The three
that differ are exactly the two resolved files plus the test adaptation:

| file | before → after numstat | why |
| --- | --- | --- |
| `apps/web/src/pages/supplier-opening-balance.tsx` | 22/7 → 22/8 | resolution: #264's typed rows + #252's `items`/map |
| `tests/e2e/supplier-adjustment.spec.ts` | 11/3 → 9/2 | resolution: #264's step 3 + #252's label assertions |
| `apps/web/src/pages/supplier-opening-balance.test.tsx` | 52/... → 81/2 | adaptation: typed testids + the corrected label |

Every other touched file (i18n, supplier-entry-display, contracts/core, the api
files, the panel, `select-trigger-label.test.ts`, `source-scan.ts`, …) is
byte-identical.

## Five invariants, asserted on the rebased tree

```
$ bun run .scratch/reviews/252/rebase-verify-direction-labels.ts
PASS  1. supplierAdjustDirectionWeOwe === «يسالنا»                i18n.ts:995
PASS  2. supplierAdjustDirectionTheyOwe === «نسالوه»              i18n.ts:996
PASS  3a. the WE_OWE hint sits beside its label and agrees        i18n.ts:997
PASS  3b. the THEY_OWE hint sits beside its label and agrees       i18n.ts:998
PASS  4a. every core.ts gloss pairs WE_OWE<->«يسالنا» and THEY_OWE<->«نسالوه»
PASS  4b. the linked-reduction refusal names the word its own guard requires
PASS  5. supplierDirectionKey() is the one label map; no surface re-derives it
         label-pairing occurrences in the tree: 1 (supplier-entry-display.ts x1); none elsewhere
ALL BULLETS HOLD   (exit 0)
```

Full output: `d24e94b-rebase-verify.log` (the script's own mutation ablations A–C are
recorded in `67c4b95-rebase.md` from the earlier rebase and are unchanged; this
rebase adds no guard).

## Gates on the rebased tree

| gate | command | result |
| --- | --- | --- |
| typecheck | `bun run typecheck` | **exit 0** (4/4 tasks) |
| lint | `bun run lint` | **exit 0** |
| web direction suites | `bun test` over `supplier-entry-display`, `supplier-adjust-panel`, `debts`, `supplier-opening-balance`, `select-trigger-label`, `cell-ltr`, `activity`, `log-copy` (8 files) | **175 pass / 0 fail**, 802 expects, 62.7s |
| api direction suites | `bun test` over `supplier-ledger`, `router`, `supplier-account-store`, `supplier-adjustment-migration` (4 files) | **318 pass / 0 fail**, 1265 expects, 22.5s |
| e2e | `bun run test:e2e tests/e2e/supplier-adjustment.spec.ts tests/e2e/supplier-account.spec.ts tests/e2e/activity.spec.ts tests/e2e/debts.spec.ts` | **exit 0, 13 passed (2.6m)** |

Logs: `d24e94b-web-direction-suites.log`, `d24e94b-api-direction-suites.log`,
`d24e94b-e2e-direction.log`. E2E ran on slot2 (`4800/5800/4801/5801`) from
`e2e-slot.sh`, with the slot's stale listeners cleared first.

## Failing-first (named assertion)

`apps/web/src/pages/supplier-opening-balance.test.tsx:2313`, before the adaptation:
`expect(captured?.rows.map((row) => row.direction)).toEqual(["WE_OWE","THEY_OWE"])`
received `["WE_OWE","WE_OWE"]` — because `pickTypedDirection(1, "يسالنا")` now
selects WE_OWE, which *is* the fix. Green after the one-line label correction.

## Not claimed

- The rebase does not re-review #264/#258/#253/#259; it proves their hunks landed and
  this PR's direction work still holds on top.
- `bun run test` (root turbo full suite) is blocked by the harness heavy-run hook
  ("this is a HEAVY run … no slot is free") even with a slot held, the same harness
  limitation the previous rebase lane recorded. The narrowed web + api suites above
  are the substitute.
- No new visual artefact: the rebase reproduces the PR's existing UI; the visual
  before/after for the #252 fix already lives in the PR's own evidence set.
