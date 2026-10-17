# #244 round 5 — debate (adversarial critic), HEAD 25dfa92

Base: `ad8445f` (origin/fix-244-blankness-ratchet). Run as an independent
read-only sub-agent; the lane applied its two findings and this file records the
re-review on the final SHA.

## Verdict

Both prior critic findings are genuinely fixed. No blocker, no new regression.
The round-5 change restores round-3 behaviour on the JSX `)`/`]` shapes, is
false-positive-neutral on the real corpus, and the demo structurally cannot touch
the real scanner.

## Findings

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | Fixed | Prior finding 1 (JSX `)`/`]` escape) reproduced: round-3 caught → round-4 escaped → HEAD caught. | `round4-before-probe.ts`: round-3=caught, round-4=`[]`, fixed=caught for both shapes |
| 2 | Fixed | Prior finding 2 (demo wrote the real scanner): the demo has no write path to the worktree and the real sha256 is unchanged. | `probe-safety-demo.sh` → `PASSED … real target untouched`; `git diff --stat -- apps/web/src/tests/blankness-gates.ts` empty |
| 3 | Correct | The new KNOWN CEILING sentence is accurate and complete for the escapes that exist. | traced both passes for the `}` fixture; ceiling names `}`, quote, `/*`, `//`, and singles out `/*` as the hiding case |
| 4 | Low | `244-round5-design.md` claimed the demo "refuses to start when the target is already dirty"; no such guard exists. Fixed in the doc. | `grep -n "status\|dirty"` → none |
| 5 | Low | A reviewer probe filter (`g.includes("<span>")`) falsely reported `JSX attr //` as escaping; the shape is actually caught. | `critic-final-verify.ts` (deleted after the review) |
| 6 | Note | `probe-safety-demo.sh` leaks its `mktemp` dir on SIGKILL (no KILL trap). Cosmetic; touches no repo file. | script read |
| 7 | Note | Inline template-receiver gates (`` `…`.trim() === "" ``) are uncaught — pre-existing, subsumed by the KNOWN CEILING "receiver that is NOT a plain member chain". Not touched. | shape matrix |

## What was checked

- **No round-3-caught shape escapes at HEAD** beyond the named ceiling. Matrix of
  27 shape tokens: no `round-3=caught, HEAD=ESCAPES` and no `round-4=caught,
  HEAD=ESCAPES`. The only remaining escapes are `/*` and `//` in JSX child text,
  both explicitly named in the ceiling (including that `/*` hides every later gate
  in the file).
- **No write path to the worktree** under mktemp failure (`exit 3` before the trap
  is set), missing `bun` (`PIPESTATUS[0]=127` → exit 1), SIGKILL, or concurrency
  (separate `mktemp` dirs). Real sha256 `c4bdbe36…` unchanged; `git diff` clean.
- **No false positive that reddens the real ratchet**: `gate-set-diff.sh` 32 → 32,
  `ADDED []` / `REMOVED []`; a 180-file corpus diff differs in exactly one file
  (`blankness-ratchet.test.ts`, the new fixture, which `numericReaderFiles()`
  filters out as a test file).
- `bun test src/lib/blankness-ratchet.test.ts` → 33 pass, 0 fail, 64 expects.

## Commands

```
bun run .scratch/reviews/244/round4-before-probe.ts
cd apps/web && bun test src/lib/blankness-ratchet.test.ts
bash .scratch/reviews/244/probe-safety-demo.sh
bash .scratch/reviews/244/gate-set-diff.sh
```
