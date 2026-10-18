# Code Review — Ticket #10 @ 0b7d644

- Tier: Standard · Base: c1bec84 · Head: 0b7d644
- Two parallel reviewer sub-agents (Standards axis + Spec axis) on
  `git diff c1bec84...3ee9def`; the follow-up commit 0b7d644 resolves the
  cross-cutting findings, re-verified against the final files below.

## Standards

**Verdict: READY — no hard violations.**

Met (with evidence): session guards on both new procedures match the
`guarded`/`guardedInput` conventions (router.ts); boundary normalization
mirrors the documented `requireBarcode` pattern with the shared
`normalizeAlgerianPhone` helper; every mutation records an activity
(`SETTINGS_UPDATED` appended to the append-only tuple, Arabic label added);
form UX matches the page standard (bordered inputs, stone-900 button,
testids, `tError` translation of stable server keys); E2E follows the
login-first shared-DB pattern with `Date.now()`-stamped unique names; no
lockfile, no money/timestamp logic touched.

Judgement calls reviewed and accepted:
1. **Non-atomic audit write** — `settingsUpdate` writes the settings row then
   `insertActivity` outside a transaction. Precedent exists
   (`backupManual` inserts its audit after the work, router.ts); a crash
   between them would leak an un-audited change. Low risk for a settings
   form; consistent with the existing pattern. Not a violation.
2. **Duplicated Code (weak)** — `requireStorePhone` re-implements the
   normalize-and-reject shape that exists inline in `admin.ts`. One
   if-throw; the shared helper is reused. Acceptable at this scale.
3. **Hydration workaround (weak)** — form state + `hydrated` guard replaces
   the controlled-input simplicity; needed so refetches don't clobber
   in-progress edits. Documented in a comment.
4. **Speculative Generality (weak)** — the `InvoiceHeader` comment
   foreshadows ticket #30 reuse; the component is real and mounted now.

## Spec

**Verdict: READY — all requirements implemented; scope additions documented.**

1. **Arabic RTL /settings screen + nav link** — `/settings` route, `الإعدادات`
   nav link, form per existing page patterns, full Arabic i18n. ✅
2. **settingsGet/settingsUpdate wired** — stubs replaced; Zod shape
   validation (`settingsUpdateInputSchema`); phone normalized to canonical
   `+213…` (reused auth helper); invalid → stable `INVALID_PHONE_NUMBER`;
   `null` **and trimmed-empty** both clear (spec's "empty clears" honored at
   the RPC boundary, not just in the UI — 0b7d644). ✅
3. **Invoice header shows name + phone** — additive `InvoiceHeader` mounted
   only in the saved purchase-invoice card; no unrelated refactor; sale
   checkout untouched for ticket #30. ✅
4. **Persistence across restarts** — DB-backed via the EXISTING
   `StorePort.getSettings()/updateSettings()` (reused, not duplicated);
   E2E reload proves it. ✅
5. **Unit + E2E tests** — 5 new router tests + ticket10 e2e covering
   edit→save→reload→header. ✅

Scope additions (documented, not requested verbatim): the `SETTINGS_UPDATED`
audit type + activity entry — consistent with the "every mutation is
audited" repo norm and listed in `.scratch/implementation/10-design.md`.

Residual note: the form keeps showing the raw pre-normalization input until
reload (hydration guard); persisted value is canonical. Cosmetic, E2E
reload assertion masks it.

## One-line summary

Standards: 0 hard violations (4 accepted judgement calls, all low) —
clean. Spec: 0 missing/incorrect requirements (2 documented scope notes) —
complete.