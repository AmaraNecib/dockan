# Test Audit — Ticket #10 @ 0b7d644

- Tier: Standard · Base: c1bec84 · Head: 0b7d644 (after review-fix commit)
- Battery: 3-agent test-audit (edge case hunter / coverage analyst / quality
  reviewer) run via parallel reviewer subagents on the 513d429..3ee9def diff;
  the fix commit 0b7d644 closes the two actionable findings, verified below.
- Gates at final HEAD: `bun run typecheck` 3/3 · `bun run lint` clean ·
  `bun run test` 156 pass / 1 fail (the 1 fail is the PRE-EXISTING
  date-coupled `backups.test.ts` flake, reproduced at base c1bec84 with all
  ticket-10 changes stashed — not introduced here) ·
  `DOKAN_PORT=4323 DOKAN_WEB_PORT=5179 bun run test:e2e -- --workers=1` 10/10.

## Coverage map (every acceptance criterion pinned)

| Criterion | Unit (router.test.ts settings describe) | E2E (ticket10.spec.ts) |
| --- | --- | --- |
| Session guard on both procedures | `UNAUTHORIZED` for settingsGet + settingsUpdate | implicit (login-first) |
| Seeded defaults before edits | `{storeName:"Dokan", storePhone:null}` | — |
| Normalize phone → +213, persist, audit | `066 12 34 56 7` → `+213661234567`, round-trip, SETTINGS_UPDATED activity | save → reload shows canonical value |
| Clear phone (null **and** trimmed-empty) | both signals → `storePhone null` | — |
| Invalid phone rejected, nothing written | `266…`, `abc`, landline `021…` → INVALID_PHONE_NUMBER, settings unchanged | — |
| Partial update keeps the other field | phone-only update → storeName preserved | — |
| Empty store name rejected (zod) | `"   "` rejects | — |
| Invoice header reflects identity | — | purchase saved-card shows edited name + `+213661234567` |

## Findings and disposition

| Finding (role) | Severity | Disposition |
| --- | --- | --- |
| `settingsGet` failure → infinite skeleton, no error/retry UI (edge hunter) | 🟠 | **FIXED (0b7d644):** settings page renders a `settings-get-error` block with `role="alert"` + retry button (mirrors activity.tsx). |
| Empty-string phone rejected while null clears; zod lets `""` through (edge hunter) | 🟠 | **FIXED (0b7d644):** router maps trimmed-empty `storePhone` to `null`; comment documents it; router test covers `""`-clears. |
| Empty/whitespace-only storeName untested (coverage) | 🟡 | **FIXED:** `settingsUpdate({storeName:"   "})` rejection test added. |
| Phone-only partial update untested (coverage) | 🟡 | **FIXED:** partial-update test preserves the untouched storeName. |
| Unit tests share mutable store state; order-dependent (quality) | 🟡 | Accepted — matches the file's existing style; bun:test runs describes in order; the defaults test heads the describe. |
| `message`/`error` not cleared on field edit (quality) | 🟡 | Accepted — `onSubmit` clears both; cosmetic. |
| Trailing newlines missing (quality) | 🟡 | **FIXED (0b7d644).** |
| E2E mutates shared-DB settings for all later specs (quality note) | note | Accepted — spec uses a `Date.now()` stamped unique name; no other spec reads settings. |
| Settings update audit write non-atomic with the settings write (edge hunter) | note | Accepted judgement call — matches the existing `backupManual` precedent (insertActivity after the work, not in a tx). |

## Quality notes on the new tests

Assertions are specific (exact `toEqual` on the canonical phone form, no-write
check after rejection, round-trip re-read after clear). E2E uses the shared-db
wisdom: unique stamped names, `toHaveValue` equality on reload (persistence
proven without wall-clock waits), auto-retrying `expect` for the header block.

**VERDICT: PASS** (grade B+ → A after the two orange findings closed).