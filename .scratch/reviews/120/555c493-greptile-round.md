# Issue #120 — Greptile review round (PR #132)

- **Fixed code SHA / evidence HEAD:** `555c493f302489914eccced97efd5cfe6c949379`
- **Base:** `origin/develop` @ `1d02f93`
- **Prior evidence:** `5f94d75-debate.md`, `5f94d75-test-audit.md`,
  `5f94d75-code-review.md` (rebased integration round)

All 7 PR #132 findings fixed in this worktree, each with a regression test.

| # | Finding | Fix | Test |
|---|---------|-----|------|
| P1.1 | Typing an existing party's exact name and saving left `counterparty_id` null, splitting the debtor balance | `PartySelection` gains `needsChoice`; the picker flags an exact normalized-name match with no selected record (on keystroke and when the list resolves) and renders an inline alert; `sale.tsx`/`purchase.tsx` refuse to submit that state with the translated `partyChooseExisting` copy. Typed-only stays valid when nothing matches. | `party-picker.test.tsx` (needs choice on exact match, clears on pick, typed-only when no match, sees through a bidi mark) + `sale.test.tsx` (save blocked, no invoice input sent) |
| P1.2 | The detail form initialised name/phone once, so a concurrent update was silently overwritten | `PartyForm` refreshes fields the operator has not touched when the `party` prop changes, and submits only changed fields; an unchanged submit is a no-op (no write, no audit row) | New `party-forms.test.tsx`: refresh untouched field, keep an operator's edit, submit only the changed phone, no-op write; `parties.test.tsx` detail edit now asserts the name-only patch |
| P1.3 | Arabic-Indic digits were not folded, so `٠٥٥٠١٢٣٤٥٦` ≠ `0550123456` | New `foldArabicDigits` (U+0660-0669, U+06F0-06F9) in `contracts/phone.ts`, applied in `normalizePartyPhone` and in the web `partyQueryLooksLikePhone` | Store: Arabic and Persian digits store as the canonical `+213…` and collide with ASCII; `party-match.test.ts`: Arabic-Indic filter/owner match and phone-shape detection |
| P1.4 | The debts query labelled an id-backed group with an invoice's historical name | `debtSummaries` LEFT JOINs customers/suppliers and labels id-backed groups with the party's **current** name, falling back to the historical name when the record is missing (orphan ids keep the old label) | Store: rename a party → summary shows the new name, invoice snapshot unchanged; pre-existing "never merges an id-backed party with a same-named free-form party" still passes; router: `reportsDebts` label after rename |
| P1.5 | `normalizeTextKey` did not strip U+061C, so `علي\u061C` split from `علي` | Added U+061C to the name and phone invisible-mark ranges | Store backfill groups `علي`, `علي\u200F`, `علي\u061C` into one party; `party-match.test.ts` duplicate warning sees through U+061C |
| P2.6 | The backfill rescanned every distinct spelling per group inside the write transaction | One pass builds `Map<key, {representative, spellings[]}>`; the write loop iterates each group's own spellings, never the full name set | Existing backfill variant/reuse/idempotency tests cover the behaviour |
| P2.7 | `settleInvoice` ran only after all assertions; a failure leaked unpaid balances into later specs | Cleanup moved to `test.afterEach`, which runs on failure too, and it now sweeps the invoices list for this spec's unique party names and pays each remaining balance (works even when no invoice number was captured) | Full e2e suite: 38/38 with the afterEach cleanup; the following `debts.spec` global totals stay exact |

## Notes

- P1.4's label fallback was caught by the pre-existing "never merges an id-backed
  party with a same-named free-form party" test: a plain `COALESCE(customers.name,
  suppliers.name)` turned orphan-id groups' labels into NULL. The fix keeps
  `invoices.counterparty_name` as the final fallback.
- P1.1 covers both the sale and purchase forms; the picker test exercises the
  shared mechanism and the sale page exercises the submit guard.

## Gates at 555c493

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 474 web tests + API suites pass (235 in the two touched API files)
- `bun run test:e2e` — 38/38 pass
