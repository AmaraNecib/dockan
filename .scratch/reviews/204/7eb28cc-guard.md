# #204 — Guard evidence (review round 2, PR #219)

Reviewed head: `7eb28cc23d1c88bcd5e97ea923ecd90613c4c8e4`
Delta scope: `2ea36e8...7eb28cc` (the two Greptile findings on PR #219)
Feature base: `8a7a7fa35de501efee15a802430193003926633d` (develop merge-base)
Tier: High-assurance (money-entering screen; both findings are silent-loss)
Branch: `fix-204-dropped-amount`

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3 packages) |
| Lint | `bun run lint` | pass (`oxlint`, 0 errors) |
| Unit | `bun run test` | **web 1057 pass / 0 fail** (70 files) + scripts 14 pass / 1 skip |
| Skills mirror | `bun run skills:check` (Husky) | in sync (32 skills) |

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | pass (3/3, 18.5s) |
| Lint | `bun run lint` | pass (0 errors) |
| Unit | `bun run test` | **web 1057 / 0** + scripts 14 / 0 (1 skip); affected file 61/0 |
| E2E | `DOKAN_PORT=4700 DOKAN_WEB_PORT=5700 DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701 bun run test:e2e` | **75 passed** (6.0m), incl. both `#204` specs |
| Working tree | `git status --short` | clean (only ignored artifacts) |

The full suite ran on the four isolated ports of e2e slot 1 (`e2e-slot.sh
acquire fix-204-dropped-amount`, released on exit). No contention; first try, no
flaky spec, no rerun. A previous full run on `059e882` (behaviorally identical
production code) also passed 75/75 on slot 2 (`4800/5800/4801/5801`).

### Review-driven corrections (delta reviews found these)

- **Race test was load-flaky.** Releasing the lookup while a real
  `invalidateQueries` was in flight let the cache write lose to the resumed
  `save()` under load (the spec reviewer reproduced 6/6 failures under load,
  15/15 green when quiet). Rewritten to publish the fresh list with
  `setQueryData` (a synchronous cache write) before releasing the lookup, so the
  resumed `save()` observes the fresh cache and the removal effect has not
  committed. Re-verified **25/25 under 4 CPU burners**, and it still fails when
  `removalBlocksSave()` is reduced to the ref-only version (`captured` non-null).
- **Comment overclaimed.** `livePresentSupplierIds` no longer claims to cover a
  refetch that has not written the cache yet; the doc comment now scopes the fix
  to the "refetch finished, effect not committed" window.

## Review evidence (High-assurance)

| File | SHA | Fresh? |
|---|---|---|
| `.scratch/reviews/204/7eb28cc-debate.md` | 7eb28cc | yes |
| `.scratch/reviews/204/7eb28cc-test-audit.md` | 7eb28cc | yes |
| `.scratch/reviews/204/7eb28cc-code-review.md` | 7eb28cc | yes |

Superseded `aae4a7f-*` and `e4d1e73-*` evidence retained under
`.scratch/reviews/204/superseded/`.

## Phase 3 — pre-report

- Local gates green (above); working tree clean.
- Review evidence present and current for the head SHA.
- Greptile: this lane does not push; the parent re-requests the hosted review on
  the new head. The two findings this round closes are addressed in code + tests.
- Deferred (documented, non-blocking): the in-flight, not-yet-written refetch
  window is inherent to a client-only gate (the finding is "refetch finishes");
  the reset test's replacement list is unchanged, so reset→changed-list is
  untested; the effect body and the write gate repeat the same three calls
  (`droppedFilledDrafts` is already the shared pure seam).

## Verdict

Guard 2 green. Ready to push (force-with-lease) and report. No merge.
