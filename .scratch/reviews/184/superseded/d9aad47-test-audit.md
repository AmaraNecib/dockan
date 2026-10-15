# Test-audit evidence — #184 review-fix round 3 (PR #190)

- PR base: `origin/develop` @ `f757211`; round-2 code head `62112fe`; round-3
  review head `3a4963a`; final head `d9aad47`.
- Tier: **High-assurance**. Agents: edge-case hunter + coverage analyst
  (`reviewer`) and quality reviewer (`oracle`), plus a focused re-review of the
  follow-up delta.

## The brief's required tests

| Requirement | Test |
|---|---|
| **1** — hold the recovery lookup, press Escape, release, assert the dialog STAYS CLOSED | `supplier-opening-balance.test.tsx` `keeps the dialog closed when Escape lands while a refusal's recovery lookup is pending`: `rejectTargetChanged` refuses the confirmed save, `resolveHold` parks the recovery lookup, Escape fires, the hold is released, and the dialog is asserted `null` after settle. Fails on the pre-fix source (dialog re-opens). |
| **2** — `OPENING_BALANCE_TARGET_CHANGED` maps to the specific key, not `errorGeneric` | `i18n.test.ts` `names the moved opening-balance destination instead of the silent fallback` (asserts `serverErrorKey === key`, `tError !== errorGeneric`, Arabic script) and the family loop. Fails pre-fix at `toBe(key)`. |
| **3** — walk every refusal and confirm a real Arabic message | `opening-balance refusals stay translatable` enumerates 13 keys and asserts, per key, `serverErrorKey(key) === key`, no `errorGeneric`, non-empty, Arabic, plus copy distinctness. |

## Refusal walk (the class behind the silent fallback)

Every stable refusal the opening-balance screen can surface, all with real
Arabic copy; none relies on the `errorGeneric` fallback by design:

| Refusal | Source |
|---|---|
| `OPENING_BALANCE_EXISTS` | `router.ts:1032,1063` |
| `OPENING_BALANCE_TARGET_CHANGED` | `router.ts:1055` (message added this round) |
| `DUPLICATE_OPENING_BALANCE_ROW` | `router.ts:998,1079` |
| `DUPLICATE_ADJUSTMENT` | `adjustmentRefusal` DUPLICATE (`router.ts:180`) |
| `PARTY_NOT_FOUND` | `router.ts:1022` |
| `ADJUSTMENT_EXCEEDS_REMAINING` | `ADJUSTMENT_REFUSAL` (`router.ts:181`) |
| `ADJUSTMENT_INVOICE_DIRECTION` | `ADJUSTMENT_REFUSAL` (`router.ts:182`) |
| `ADJUSTMENT_LINK_INVALID` | `ADJUSTMENT_REFUSAL` (`router.ts:183`) |
| `ADJUSTMENT_INVALID_AMOUNT` | `ADJUSTMENT_REFUSAL` (`router.ts:184`) |
| `ADJUSTMENT_NOT_TRANSACTIONAL` | `ADJUSTMENT_REFUSAL` (`router.ts:185`) |
| `INVOICE_NOT_PURCHASE` | `ADJUSTMENT_REFUSAL` INVOICE_MISMATCH (`router.ts:186`) |
| `AUTH_REQUIRED` | `requireSession` (`router.ts:258,263`) |
| `FORBIDDEN` | `requireSession` (`router.ts:269`) |

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| T1 | 🔴 | The required test had no positive control: deleting the recovery resolve would also leave the dialog closed and pass vacuously. | **Fixed**: `expect(resolveCalls).toBe(2)` after the release (1 submit + 1 recovery resolve). |
| T2 | 🟠 | The follow-up class fixes were untested: Escape from an input behind the dialog, and a dismissal not latching. | **Fixed**: `dismisses on Escape from an input behind the open dialog` (fails on `3a4963a`, where the handler sat on the dialog div) and `does not suppress a legitimate dialog after an earlier dismissal` (later submit re-opens naming the moved account). |
| T3 | 🟠 | The family loop proved key existence but not that two refusals cannot share one sentence. | **Fixed**: `new Set(copies).size === copies.length`. |
| T4 | 🟠 | The new test used a synchronous `act(() => clickOn(...))` + microtask flush with no explanation; an async `act` deadlocks on the held promise (~47 s hang measured). | **Fixed**: a comment states the rationale so a maintainer does not normalise it back. |
| T5 | 🟡 | The comment "the dialog names the moved account but stays CLOSED" described an assertion the test does not make. | **Fixed**: reworded to "stays CLOSED (it is not re-opened with the moved name)". |
| T6 | 🟡 | The single-key i18n test is a strict subset of the family loop. | **Accepted** — the brief explicitly asks for a specific-key test; it documents the exact finding. |
| T7 | 🟡 | Setup duplication (~10 lines) across the dialog tests; the family list is hand-maintained. | **Deferred** — test-only; the list is complete for today's endpoints and its doc-comment says so. |

## Verification

- Red-checks: required test fails pre-fix (dialog re-opens); key test fails
  pre-fix (`errorGeneric`); Escape-from-input test fails on `3a4963a`.
- `bun test src/lib/i18n.test.ts src/pages/supplier-opening-balance.test.tsx`
  at `d9aad47`: all new tests pass. Full web suite `--max-concurrency=1`:
  **979 pass / 0 fail**. api **905 / 0**, desktop **57 / 0**.
- Full Playwright `DOKAN_PORT=4831 DOKAN_WEB_PORT=5286`: **64 pass / 0 fail**.
- Load note: the canonical `turbo test` (`--max-concurrency=2`) run produced
  ~430 five-second timeouts in unrelated files (debts, expenses, vault) while
  three sibling lanes saturated the 12-core host; the per-file tests pass in
  isolation and the full web suite is green at `--max-concurrency=1`. No
  failure touched the changed files.
