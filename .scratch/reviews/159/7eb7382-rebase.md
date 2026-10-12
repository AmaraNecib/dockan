# #169 rebase onto develop@957d059

The branch was rebased (not merged) onto `origin/develop` at `957d059`, the squash-merge of PR #168 (#167 password eye), just before re-review.

## What the rebase changed
- **Only `apps/web/src/index.css` conflicted.** Resolution is the union of two independent appended rules:
  - `input[type="password"]::-ms-reveal { display: none; }` — from #168 (already reviewed and merged).
  - `.cell-ltr { direction: ltr; unicode-bidi: isolate; text-align: right; }` — from #166 (this PR).
- `apps/web/src/lib/i18n.ts` auto-merged (both PRs added keys in different places). No other file conflicted.
- The #166/#159/#160 code delta is **byte-identical** to the reviewed commit `4211271`; the only new lines in the tree are #168's already-reviewed hunks in the two shared files.

## Guard after the rebase (branch HEAD `7eb7382`)
- `bun run typecheck` → 0 (3/3 tasks)
- `bun run lint` → 0
- `bun run test` → **657 pass / 0 fail** (51 files) — includes #168's vault/App tests from develop plus this PR's suite.

## Evidence chain
- **Substantive review (unchanged logic):** `4211271-test-audit.md`, `4211271-code-review.md` (and the superseded `ffde449-*` pair). Reviewed SHA `4211271` predates the rebase; its reviewed content is preserved verbatim in the rebased tree apart from the two shared-file unions above.
- This note is the only post-rebase change; it is evidence-only.
