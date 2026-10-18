# Code-review evidence — #184 review-fix round 3 (PR #190)

- PR base: `origin/develop` @ `f757211`; round-2 code head `62112fe`; round-3
  review head `3a4963a`; final head `d9aad47`.
- Tier: **High-assurance**. Two-axis review (Standards + Spec) at `3a4963a`,
  plus a focused critic at `d9aad47`.

## Standards

- `apps/web/src/lib/i18n.ts` — one new key, sentence-parallel with its
  neighbours; no duplication. Matches convention.
- The refusal-family enumeration turns `serverErrorKey`'s silent fallback into
  an exhaustive, checkable assertion — a real standard win.
- `dismissalRef` is **not** Duplicated Code / Shotgun Surgery. `attemptRef`
  invalidates on any batch edit (including existing-row edits, which must NOT
  suppress the refusal refresh); `resolveKeyRef` is the live lookup key;
  `dismissalRef` records only explicit dismissal. Three distinct signals, and
  the block comment (`supplier-opening-balance.tsx:64-70`) states the
  distinction.
- **Divergent Change (fixed at `d9aad47`)** — the recovery success branch added
  the dismissal check while the sibling failure branch omitted it. Both branches
  now carry `mounted && resolveKeyRef === saveResolveKey && dismissalRef ===
  saveDismissal`.
- **Comment accuracy (fixed at `d9aad47`)** — the docblock listed "leaving the
  page" as a dismissal route while the back link used `invalidateAttempt`; the
  link now routes through `abandonAttempt`, so the claim holds.
- No documented code standards exist beyond repo convention (`AGENTS.md` carries
  only a search-scope rule; no `CONTRIBUTING.md`/`CODING_STANDARDS.md`), so
  remaining items are baseline judgement calls: the bare `number` refs as tokens
  (idiom, accepted) and the set of parallel refs threaded through
  `save`/`resolveForSubmit` (documented, cheap).
- No blockers.

## Spec

| Brief requirement | Status |
|---|---|
| Honour an explicit dismissal before reopening (record it, let the recovery path consult it) | ✅ `dismissalRef` bumped only in `abandonAttempt`; `save()` captures `saveDismissal`; the recovery re-open consults it. |
| Prefer removing the divergence over guarding one call site | ✅ Chosen: every dismissal route funnels through the one primitive. The follow-up extended it to the back link, the form-level Escape, and the recovery failure branch. |
| Hold the recovery lookup, press Escape, release, assert STAYS CLOSED | ✅ Present; fails pre-fix. |
| Arabic message says the destination changed and points at the newly named supplier | ✅ `"تغيّرت وجهة الاسم؛ تحقّق من المورّد المذكور حديثاً قبل التأكيد"`. |
| A test asserting the specific key, not `errorGeneric` | ✅ Present; fails pre-fix. |
| Walk every refusal and confirm a real Arabic message | ✅ 13-key enumeration; the list is complete against `router.ts` today; no family relies on the fallback by design. |
| Scope creep | None. |

**Standards verdict: pass. Spec verdict: pass.**

## Focused re-review of the follow-up delta (`3a4963a..d9aad47`)

Score **8/10, no blockers.** Confirmed correct: the recovery-failure guard
mirrors the success guard; the `confirming` guard is not stale (inline handler
recreated each render); the back-link `abandonAttempt` preserves the e2e
"leaving via the back link while the lookup is pending writes nothing" flow.
Low notes accepted/documented: the form-level Escape depends on Radix
portalling to `document.body` (true today); `error` is not cleared by a
dismissal, so an in-flight write refused after Escape still shows the refusal
(the write did fail — honest); the handler checks `confirming`, not
`confirming && !confirmStale` (harmless, `abandonAttempt` is the same action).

## Guard results at `d9aad47`

- `bun run typecheck` — 3 tasks successful (exit 0).
- `bun run lint` — clean (exit 0).
- Unit: api **905 pass / 0 fail**, desktop **57 pass / 0 fail**, web
  **979 pass / 0 fail** (`--max-concurrency=1`; the canonical `--max-concurrency=2`
  run hit load-induced 5 s timeouts in unrelated files under three sibling lanes).
- Playwright `DOKAN_PORT=4831 DOKAN_WEB_PORT=5286 bun run test:e2e` — **64 pass /
  0 fail** (8.2 m). Note: an earlier run at the same ports failed
  `backups.spec.ts` only because it was given a custom `E2E_DATA_DIR`; that spec
  hardcodes `.e2e-data`, so the default data dir is required.
