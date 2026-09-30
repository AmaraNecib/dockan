# PR #107 / issue #100 — adversarial review synthesis

Reviewed head `0e8ade9`, merge-base `0b4d5a1`. Four independent fresh-context
reviewers (`standards.md`, `spec.md`, `critic.md`, `defender.md`).

| # | Finding | Score | Decision |
|---|---|---|---|
| 1 | Phone examples embedded as bare ASCII in an RTL sentence | hard (standards) | **Fixed** — both runs wrapped in U+2066/U+2069 isolates, and the digits now come from one pair of constants |
| 2 | better-auth's `PASSWORD_TOO_SHORT` mapped to our 4-character copy; better-auth's own minimum is 8, so the advice would loop forever | 6 | **Fixed** — mapping dropped; only our own validator sentence (`>=4`) resolves to that copy |
| 3 | The `"Password too short"` sentence the fallback matched is emitted by nothing | 5 | **Fixed** — pattern dropped; the test now uses the sentence Zod actually emits |
| 4 | `AUTH_INVALID_CREDENTIALS` blamed the password field while its copy names both fields | 5 | **Fixed** — it stays on the summary and focuses the alert |
| 5 | `report` was a fresh closure per render, so the login notice effect re-ran on every render | 4 | **Fixed** — `useCallback` |
| 6 | The setup notice was never cleared, so login → forgot → login re-announced it | 4 | **Fixed** — consumed once; `forgot-back` gets a test hook |
| 7 | Issue item 4 ("stop the bad input") was submit-time only | 4 | **Fixed** — the phone field is capped at the longest accepted form (13) |
| 8 | `required` was kept but `minLength` dropped | 3 | **Fixed** — `minLength` from the contracts constant, now exported as `MIN_PASSWORD_LENGTH` |
| 9 | `MIN_PASSWORD_LENGTH` was a second literal mirroring the contract | judgement | **Fixed** — exported from `packages/contracts` and imported by both the pre-check and the copy |
| 10 | Two e2e assertions could never fail (they followed an exact `toHaveText`) | 6 | **Fixed** — replaced with the focus assertion that actually distinguishes the two cases |
| 11 | The locked-out account has no key of its own | spec partial | **Dismissed** — the api refuses with `RESET_LOCKED` (`apps/api/src/rpc/router.ts:215`), which is mapped and tested; `SETUP_LOCKED` is only a log tag |
| 12 | Setup→login handoff is scope creep | spec note | **Kept** — it is what makes the `SETUP_ALREADY_DONE` instruction usable |
| 13 | `role="alert"` plus `aria-describedby` announces a field error twice | 2 | **Deferred** — issue filed; the fix changes the alert's role contract and touches four tests for a score-2 finding |
| 14 | Five auth helpers in `App.tsx` (Divergent Change) | judgement | **Deferred** — issue filed; a module move is diff noise inside an error-copy PR |
| 15 | `SERVER_ERROR_KEY` drops non-SCREAMING_SNAKE keys that do have translations | spec note | **Deferred** — issue filed; no producer emits such a key today |
