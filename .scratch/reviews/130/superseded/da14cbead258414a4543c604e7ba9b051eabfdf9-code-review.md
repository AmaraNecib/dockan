# #130 — Code review
Reviewed HEAD: `da14cbead258414a4543c604e7ba9b051eabfdf9` (`feat-130-arabic-name-variants`)
Code reviewed at `5aa47930`; re-pinned to this HEAD — the only change since is the wisdom captured under `.agents/wisdom/` (no code change).
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, merge-base)
Diff: `git diff fc951133134a9b0b18b5ae38f9658665c29e73ec...da14cbead258414a4543c604e7ba9b051eabfdf9`
(6 files, +411/−19: `party-match.ts`, `party-match.test.ts`, `party-picker.test.tsx`, `i18n.ts`,
`tests/e2e/customer-name-variants.spec.ts`, `.scratch/implementation/130-design.md`)
Tier: Standard. Method: the skill's two axes (Standards, Spec) run in-lane against the pinned diff —
see the method note in `-debate.md` (no sub-agent tool in this lane).

## Standards

**Verdict: pass, no blockers.** Sources: `docs/engineering-workflow.md`, `AGENTS.md` (search scope),
`CONTEXT.md` (domain terms), plus the Fowler smell baseline.

- **ADR-0007 separation holds.** `packages/contracts/src/core.ts` (`normalizeTextKey`) is not in the
  diff. The new key lives in `apps/web/src/components/parties/party-match.ts` as a documented local
  helper (`nameVariantKey`), and the picker's `needsChoice` gate still uses `normalizeTextKey`. The
  guard test asserts both halves at once.
- **Reuse over re-invention** (brief requirement): nothing was added to `packages/contracts`; the
  warning uses `foldArabicVariants(...)[1]` from #165, and the design doc states which half was
  taken and why (narrower than the search key).
- **Naming and comments.** `nameVariantKey` reads as what it is; the `[1]` (article-preserved) choice
  is explained where it is used, not only in the design doc.
- **No dead code, no speculative generality.** No new public API, no new config, no unused import
  (`foldArabic` was replaced by `foldArabicVariants`; `normalizeTextKey` is still imported and used
  by the exact-first pass). `bun run lint` (oxlint + anti-slop) exits 0.
- **Source-only change policy.** Only named source/test/evidence files were staged; no
  `git add -A`; builds and `.e2e-data` are ignored artifacts, `.dokan-port*` and `.e2e-data` were
  wiped before the E2E run.
- **Judgement call, not a violation.** The E2E `afterEach` cleanup duplicates the shape of
  `customers.spec.ts`'s helper. Extracting a shared `deleteParties(page, names)` into
  `tests/e2e/` would DRY it, but that means editing an unrelated spec; left as a local helper.
- **Judgement call.** The nested `likelyDuplicate` predicate is the clearest expression of "folded
  names match AND not one identity" available in one function; hoisting `nameVariantKey(party.name)`
  into a precomputed array is the (deferred) performance form of the same logic.

## Spec

**Verdict: pass, no blockers.** Spec sources: GitHub issue #130 and the lane brief.

- **Alef and ya folded for the duplicate check** — `آ أ إ ٱ ٲ ٳ → ا`, `ى ئ → ي`, plus the ta-marbuta
  pair the reused fold brings along; the issue's own case «على علي»/«علي علي» is pinned in unit,
  component and E2E tests.
- **«أحمد» vs «احمد» warns** (unit), **«مصطفى» vs «مصطفي» warns** (unit).
- **Genuinely different names do not warn** — real-letter negatives at unit level and an E2E
  negative control.
- **Warning, not a hard block** — `createDisabled`, `needsChoice` and the store are untouched; both
  the component and the E2E prove the second record is created past the warning.
- **Storage unchanged** — nothing writes or normalises the stored name; the E2E shows the created
  row keeps the owner's spelling.
- **Copy Arabic via i18n, no API display text** — one i18n string updated; no server string added.
- **Scope** — the change is confined to the picker's warning (the supplier picker shares the code
  path and inherits it, which matches the same debtor-splitting risk). No pagination, contract,
  API, schema or migration change. The `/customers` create form (no warning today) is recorded as a
  non-goal in the design doc.
- **Not asked for, deliberately not built** — fuzzy/edit-distance name matching (that is #165's
  search fallback) and article folding. Both are excluded precisely because they widens false
  positives beyond the issue.

## Deferred

- Greptile review: unavailable in this lane (`greptile whoami` → `error: refresh failed:
  access_denied`; `greptile review --json --branch develop` → `error: this review is too large to
  send`, the large-diff trap in `.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`). The
  documented workaround is the hosted PR path, which requires a push the lane must not do — the
  parent owns it.
- No required CI workflow exists on the branch, so the local Guard Phase 2 run is the CI gate
  (per `feature-implement` step 11).
- Deferred niceties with no issue filed by this lane: shared E2E party-cleanup helper; memoizing
  folded names for large customer lists; duplicate-name warning on the `/customers` create form.

## Commands

```
git diff fc951133134a9b0b18b5ae38f9658665c29e73ec...da14cbead258414a4543c604e7ba9b051eabfdf9
bun run typecheck                     # exit 0
bun run lint                          # exit 0
bun run test --force                  # exit 0 (web 856 pass / 0 fail; api 827 pass / 0 fail)
bun run test:e2e                      # exit 0 — 56 passed
```
