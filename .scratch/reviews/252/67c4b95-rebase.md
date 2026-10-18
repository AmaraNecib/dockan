# #252 rebase onto develop — evidence

**Gate:** rebase + verification (brief: `fix-252-direction-labels-rebase`).
**Tier:** Standard, per the brief (a rebase adds no new behaviour). The named
failure mode it *could* violate is direction (who owes whom), so the direction
bullets below are treated as the gate rather than a smoke check, and the
ablation table proves each one bites.

| | |
| --- | --- |
| PR branch before | `c67c641` (`fix-252-direction-labels`, 8 commits) |
| old merge-base | `d843566` |
| develop at rebase | `03d1878` (3 commits ahead: #259, #258, #253) |
| **rebased HEAD** | **`67c4b95`** (8 commits replayed, same messages) |
| conflicted files | **1** — `apps/web/src/lib/supplier-entry-display.ts`, in commit 1/8 (`fd19ddd`) |

## Red before, green after (the failing-first run)

```
$ git merge-base --is-ancestor origin/develop HEAD   # pre-rebase, on c67c641
exit 1                          -> CONFLICTING, the PR's only blocker

$ git merge-tree --write-tree HEAD origin/develop     # pre-rebase preview
CONFLICT (content): Merge conflict in apps/web/src/lib/supplier-entry-display.ts
exit 1

$ GIT_EDITOR=true git rebase origin/develop
Auto-merging apps/api/src/lib/supplier-ledger.ts
Auto-merging apps/api/src/rpc/router.test.ts
Auto-merging apps/api/src/store/drizzle-store.ts
Auto-merging apps/web/src/lib/i18n.ts
Auto-merging apps/web/src/lib/supplier-entry-display.ts
CONFLICT (content): Merge conflict in apps/web/src/lib/supplier-entry-display.ts
error: could not apply fd19ddd... fix(web,api): put each supplier-direction label on the value its hint describes (#252)
Rebasing (2/8) … (8/8)
Successfully rebased and updated refs/heads/fix-252-direction-labels-rebase.

$ git merge-base --is-ancestor origin/develop HEAD   # post-rebase, on 67c4b95
exit 0                          -> mergeable, the blocker is gone
```

`i18n.ts` (the file the brief expected to conflict) **auto-merged**: its two
sides are disjoint additions — #253's `activitySupplier*` / `logEvent_*` keys and
this PR's four direction keys — so git kept both. The conflict it did not predict
was in `supplier-entry-display.ts`.

## The one conflict: which side each hunk came from, and why both survive

`fd19ddd` (ours) added `supplierDirectionKey` — the single direction→label map —
and pointed `supplierEntryDirectionKey` at it. develop (#265) added
`adjustmentDirectionKey(token: string | null)`, the same pairing written out for
the activity log's raw token, and pointed `supplierEntryDirectionKey` at *it*.

Keeping develop's hunk verbatim and ours as written would leave **two** maps —
the exact drift class #252 exists to kill, so bullet 5 below would read 2.
Dropping develop's hunk instead breaks `apps/web/src/pages/activity.tsx:14`
(ablation C). The resolution keeps develop's name, docstring spine and
`string | null` signature, and makes its body read through the one map:

```ts
export function adjustmentDirectionKey(
  token: string | null,
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" {
  return supplierDirectionKey(token === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");
}
```

Behaviour is identical for every input (`THEY_OWE` → they-owe, anything else
including `null` → we-owe). Everything else in the file is develop's file plus
our one map, so the diff against develop is 6 lines wide.

## The PR's own diff survived the rebase byte-for-byte

`git diff d843566 c67c641` vs `git diff origin/develop HEAD`, compared by
`git patch-id --stable`:

| file | PR diff identical | added/removed (before → after) |
| --- | --- | --- |
| `apps/web/src/lib/i18n.ts` | yes | 2/2 → 2/2 |
| `apps/web/src/components/parties/supplier-adjust-panel.tsx` | yes | 9/7 → 9/7 |
| `apps/web/src/pages/supplier-opening-balance.tsx` | yes | 22/7 → 22/7 |
| `packages/contracts/src/core.ts` | yes | 5/5 → 5/5 |
| `apps/api/src/lib/supplier-ledger.ts` | yes | 5/2 → 5/2 |
| `tests/e2e/supplier-adjustment.spec.ts` | no (context only) | 11/3 → 11/3 |
| `apps/web/src/lib/supplier-entry-display.ts` | no | 40/2 → 48/4 (the resolution) |

The e2e spec's patch-id moves because one neighbouring context line is #258's
`INV-\d+` → `SUP-\d+`; its own three assertion hunks are identical.

## The five bullets, asserted on the rebased tree

`.scratch/reviews/252/rebase-verify-direction-labels.ts` — same script run
before the rebase (all 7 checks PASS on `c67c641`, `rebase-pre-verify.log`) and
after (`67c4b95`, `rebase-post-verify.log`):

```
$ bun run .scratch/reviews/252/rebase-verify-direction-labels.ts
PASS  1. supplierAdjustDirectionWeOwe === «يسالنا»                i18n.ts:995
PASS  2. supplierAdjustDirectionTheyOwe === «نسالوه»              i18n.ts:996
PASS  3a. the WE_OWE hint sits beside its label and agrees        i18n.ts:997 = "نحن ندين له — يزيد ما علينا" (label at 995)
PASS  3b. the THEY_OWE hint sits beside its label and agrees       i18n.ts:998 = "هو يدين لنا — ينقص ما علينا" (label at 996)
PASS  4a. every core.ts gloss pairs WE_OWE<->«يسالنا» and THEY_OWE<->«نسالوه»   7 lines scanned, 0 crossed
PASS  4b. the linked-reduction refusal names the word its own guard requires
         guard requires THEY_OWE (true); refusal "a linked adjustment must be نسالوه (it reduces the invoice)" names ["نسالوه"]
PASS  5. supplierDirectionKey() is the one label map; no surface re-derives the pairing
         pairing occurrences in the tree: 1 (supplier-entry-display.ts x1); label-key literals outside the map: none
ALL BULLETS HOLD   (exit 0)
```

Bullet 3 checks both halves of "beside": the hint resolves from the same value
(`supplierDirectionHintKey`) *and* its i18n line is within two lines of its label's.
Bullet 5 counts pairing *occurrences* (not files — see ablation A).

The mid-rebase probe at commit 1/8 (`rebase-mid-commit1-verify.log`) is the guard
watching the bug: at `fd19ddd` bullets 4a, 4b and 5 FAIL, because the contract
gloss and the surfaces are fixed by the PR's later commits. The script is not
passing because nothing changed.

## Gates on the rebased tree

| gate | command | result |
| --- | --- | --- |
| typecheck | `bun run typecheck` | exit 0 (4/4 tasks) |
| lint | `bun run lint` | exit 0 |
| direction suites (web) | `bun test src/lib/supplier-entry-display.test.ts src/components/parties/supplier-adjust-panel.test.tsx src/pages/debts.test.tsx src/pages/supplier-opening-balance.test.tsx src/lib/select-trigger-label.test.ts src/lib/cell-ltr.test.ts src/pages/activity.test.tsx src/lib/log-copy.test.ts` | **161 pass, 0 fail**, 742 expects, 8 files, 50.5s |
| direction suites (api) | `bun test src/lib/supplier-ledger.test.ts src/rpc/router.test.ts src/store/supplier-account-store.test.ts src/store/supplier-adjustment-migration.test.ts` | **316 pass, 0 fail**, 1250 expects, 4 files, 19.0s |
| full unit suite | `bun run test` | exit 0 — web 1318 pass, api 950 pass, desktop 68 pass, scripts 97 pass / 1 skip; **0 fail** |
| e2e | `bun run test:e2e tests/e2e/supplier-adjustment.spec.ts tests/e2e/supplier-account.spec.ts tests/e2e/activity.spec.ts` | exit 0 — **12 passed (1.8m)** |

Port slot `slot1` from `e2e-slot.sh` (4700/5700/4701/5701) with the stale-listener
clean-up before the run; the two suites that read the resolved adapter
(`activity.spec.ts`, `supplier-account.spec.ts`) are in that set on purpose.

## Ablation table — does each guard bite?

`ablate-252.ts` applies one wrong resolution at a time; `rebase-ablation.log`.

| ablation | the wrong resolution | detector | bit? |
| --- | --- | --- | --- |
| A | keep develop's file verbatim — the pairing exists twice in one file | bullet 5: `2 in ["supplier-entry-display.ts x2"]` | yes (after the fix below) |
| B | put the two labels back on the other value | bullets 1 + 2 FAIL, and `supplier-entry-display.test.ts`: 4 named failures (`puts the 'we owe him' string on WE_OWE…`, `reads the labels through the shared direction map…`, `pairs each direction's label with the hint…`, `names the direction it actually requires…`) | yes |
| C | take our side — drop develop's `adjustmentDirectionKey` | `tsc`: `activity.tsx(14,10): error TS2305: Module '"../lib/supplier-entry-display"' has no exported member 'adjustmentDirectionKey'`; `activity.test.tsx`: 1 fail, 1 error | yes |

**A found a guard bug.** Its first version counted files containing the pairing,
not occurrences, so ablation A still reported "ALL BULLETS HOLD" — two maps in
one file were invisible. The count is now per occurrence, and A fails as it
should. Bullet 5 also cannot see ablation C on its own: dropping the export
leaves exactly one map, which is why C's detector is typecheck plus the activity
suite and not the script. Recording that limit rather than claiming the script
covers all three.

## Not claimed

- The rebase does not re-review #258/#253/#259; it only proves their hunks
  landed without touching this PR's direction work.
- The pre-rebase review evidence under `.scratch/reviews/252/<old-sha>-*` is a
  review of `c67c641`, whose direction content is what the patch-id table above
  shows unchanged. This file is the rebase's own evidence for `67c4b95`; the only
  commit after it is this evidence commit (`.scratch/` only, non-reviewable).
