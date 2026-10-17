# #257 round 5 — code review (Standards + Spec)

Provenance: two axes reviewed by an independent reviewer sub-agent (read-only) on
the tree at `5c19b2f`. The findings it raised were responded to in `a9b6f6d`; this
file is named for the head the lane reports, and each finding states its
disposition with the SHA. The gates below were re-run on `a9b6f6d`, not inherited.

Issue: #257 · PR #266 · base `2b5504ae` · diff `git diff 2b5504ae...5c19b2f`
(plus the response diff `5c19b2f..a9b6f6d`)

## Reviewer verdict (on `5c19b2f`)

**SHIP.** Both round-5 comments closed with named assertions. No blockers. One
Medium a11y finding, one Medium test finding, three notes.

Verified with line evidence:

- the focus fallback is sound — `.disabled` is the right predicate for the
  `Button`'s `disabled` attribute, and the redirect fires during the freeze;
- the ablation is real (revert the effect → the unit assertion reddens; the e2e
  mirrors it in a browser);
- Cancel stayed enabled, so round 2's "a hung write must not trap the owner" holds;
- the e2e gate cannot hang and cannot leak a route between tests: the only
  unbounded await is `await routeHeld` inside the handler, and `releaseRoute()`
  sits in a `finally` that runs on both the pass and the throw path; `page.route`
  needs no `unroute`, and the `page`/context is torn down per test;
- no tab-order regression: `tabIndex={-1}` is a programmatic-only target, so it
  does not enter the tab sequence;
- round-2 and round-4 guards re-ran green (51 pass / 0 fail);
- `aria-label` reuses the existing `purchasesLinesTitle` key — no new i18n key;
- lint and typecheck clean. Noted honestly: there is no `.oxlintrc.json`, so the
  `tabIndex` on a table passes on its merits rather than because a rule allowed it.

## Findings and dispositions

| # | severity | finding | disposition |
|---|----------|---------|-------------|
| 1 | Medium (a11y) | The comments justified the redirect with "the frozen status line states why", but that `role="status"` line is announced when it *mounts*, not when the caret lands on the table. The table had `aria-label` but no `aria-describedby`, so at the moment of the move a screen reader heard the region's name with no reason. The "so" linked two events that do not co-occur. | **Fixed** in `a9b6f6d`: `aria-describedby={savePending ? LINES_FROZEN_ID : undefined}` on the table, `id={LINES_FROZEN_ID}` on the status line, and the unit test asserts the link and the label so the claim cannot drift out of the code. |
| 2 | Medium (test) | `expect.poll(() => routePending)` used the default 5 s expect timeout — a looser but still real wall-clock bound of the class this round removed. | **Fixed** in `a9b6f6d`: explicit `{ timeout: 15_000 }` with the reason in a comment (a wait-for-true recovers on a slow runner; a race does not). |
| 3 | Note (correctness) | The fallback also catches `target === undefined`; the comment's "the control a commit named cannot take it" under-described that widening. | **Fixed** in `a9b6f6d`: the ref and effect comments now say "missing, or (during the invoice save) disabled". The reviewer could not construct a reachable red path, and the design doc records the widening deliberately. |
| 4 | Note (comment precision) | "in this same commit" overstates by one frame — this is a `useEffect`, which runs after paint. The practical claim (one immediate landing, no deferred retry) held. | **Fixed** in `a9b6f6d`: "when this effect runs — one immediate landing, in the same render pass as the unmount that started it". |
| 5 | Note (scope) | `.scratch/implementation/257-round5-design.md` is committed. | **No action.** The reviewer recorded it rather than flagging it: this repo's convention commits scratch evidence (`2b5504a`), and the brief asked for the tier to be recorded. |

## Unverified by the reviewer, verified by the lane

The reviewer could not check the evidence file or the 6 s slow-run proof, because
`.scratch/reviews/257/` was not in the reviewed diff (it lands in the follow-up
`chore(scratch)` commit). Those are in `a9b6f6d-evidence.md` with the logs and
exit codes.

## Response gates (run on `a9b6f6d`)

| command | exit |
|---------|------|
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun run test` | 0 — 4/4 turbo tasks, `0 fail` in every workspace |
| `bun run test:e2e -- purchase-inline-product.spec.ts` | 0 — 3 passed |
| ablation A1 (pre-fix effect) | 1 — red at `purchase.test.tsx:1467` |
