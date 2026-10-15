# Debate evidence — #184 review-fix round 3 (PR #190)

- PR base: `origin/develop` @ `f757211`; round-2 code head `62112fe`; round-3
  review head `3a4963a`; final head `d9aad47`.
- Tier: **High-assurance** (money path — which supplier account receives an amount).
- Roles: `reviewer` (harsh critic) + `oracle` (charitable defender). Seven
  parallel sub-agents ran on `3a4963a` (debate, test-audit, code-review); one
  focused critic re-ran on the follow-up delta `3a4963a..d9aad47`.

## Greptile findings and the fix

| Finding | Verdict | Resolution |
|---|---|---|
| **1 — a dismissed dialog re-opens** | **Confirmed & fixed** | `abandonAttempt()` (`supplier-opening-balance.tsx:200`) is the one dismissal primitive (Escape, both Cancels, `leave()`, the lookup-key effect); it now bumps `dismissalRef`. `save()` captures `saveDismissal` (`:261`); the refusal-recovery re-open consults it (`:316`). The brief's preferred option: remove the divergence, not guard one more call site. |
| **2 — `OPENING_BALANCE_TARGET_CHANGED` had no Arabic message** | **Confirmed & fixed** | Added `OPENING_BALANCE_TARGET_CHANGED: "تغيّرت وجهة الاسم؛ تحقّق من المورّد المذكور حديثاً قبل التأكيد"` (`i18n.ts:890`) — destination changed + points at the newly named supplier the refreshed dialog shows. A specific-key test asserts it is not `errorGeneric`. |

## Critic findings and resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | 5 | **Class**: Escape was ignored when focus sat outside the inline dialog (no focus trap); the `onKeyDown` lived on the dialog div, so an Escape in an amount input behind the dialog did nothing. | **Fixed** (`d9aad47`): the handler moved to the `<form>`, guarded `if (event.key === "Escape" && confirming)`. Web test dispatches Escape from the amount input and asserts the dialog closes. |
| F2 | 5 | **Class**: the back link bumped only `attemptRef`; the recovery path never inspects it, so a recovery continuation settling before the route unmounted could re-open a dialog the owner was leaving. | **Fixed** (`d9aad47`): the back `<Link>` now routes through `abandonAttempt`. Keeps the existing e2e "leaving via the back link while the lookup is pending writes nothing" green (critic verified `closeConfirm` is a no-op pre-confirm, `invalidateAttempt` still aborts `submit`). |
| F3 | 3 | The recovery **failure** branch (`:322`) omitted the dismissal guard, so a failed re-resolve replaced the banner the owner had just dismissed. | **Fixed** (`d9aad47`): the failure branch now requires `dismissalRef.current === saveDismissal`, the mirror of the success branch. |
| F4 | 3 | "Cancel is never blocked" is false during the recovery lookup: both Cancel buttons are `disabled={submitting || bulk.isPending}` while `submitting` spans the recovery. | **Accepted** — a mouse owner cannot Cancel during a pending confirmed write; F1's form-level Escape restores a keyboard dismissal route. Pre-existing (round-2 F2), bounded, documented. |
| F5 | 3 | The i18n refusal enumeration is hand-maintained and cannot detect future drift from the router. | **Accepted** — the set covers every refusal the two endpoints surface today (critic cross-checked `router.ts:179-185, 998-1097` + the `AUTH_REQUIRED`/`FORBIDDEN` gate). A derived-from-router check is a follow-up, not this round. |
| F6 | 2 | `error` is not cleared by a dismissal, so an in-flight write refused after Escape still shows the banner. | **Accepted** — the write did fail; showing the refusal is honest. Not a reopen, no write. |
| F7 | 2 | The form-level Escape could over-fire if a future `Select` portalled inside the form. | **Accepted, noted** — Radix portals to `document.body`, outside the form subtree, so an Escape that closes a direction popup does not dismiss the dialog today. |

## Defender

The one-primitive dismissal fix is the right shape: every dismissal route
(Escape, Cancel, `leave()`, the lookup-field effect) funnels through
`abandonAttempt`, so the recovery path cannot drift from Escape again.
`attemptRef` genuinely could not be reused (an existing-row edit bumps it but
the dialog must still refresh after a refusal), so `dismissalRef` is an
orthogonal signal, not duplication. The refusal-family test turns
`serverErrorKey`'s silent `errorGeneric` fallback into a red test.

## Verification

- Red-check (pre-fix): the required Escape-during-recovery test fails at the
  final assertion with the dialog re-opened; the `OPENING_BALANCE_TARGET_CHANGED`
  key test fails at `toBe(key)` (was `errorGeneric`).
- Focused re-review of `3a4963a..d9aad47`: **8/10, no blockers**; both new
  regression tests fail on `3a4963a`; two added guards pass on both but exist to
  catch over-suppression and copy duplication.
- Guard 1+2 on `d9aad47`: `bun run typecheck` green; `bun run lint` clean;
  unit **api 905 / desktop 57 / web 979, 0 fail** (web at `--max-concurrency=1`
  because the canonical `--max-concurrency=2` run hit load-induced 5 s timeouts
  while three sibling lanes ran); Playwright at
  `DOKAN_PORT=4831 DOKAN_WEB_PORT=5286` **64 pass / 0 fail** (8.2 m).
