# #183 — code-review evidence (review-fix round 1, two axes)

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Base:** `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- **Head:** `1fa457f2e15e4b9a04f932defc3c64083cb2528d`
- **Round delta:** `git diff bd22a57..1fa457f` —
  `apps/web/src/pages/supplier-opening-balance.test.tsx` only (+58/−22).
  Test-only; production and server code unchanged this round.
- **Verdict:** Spec — pass (no missing/partial requirements; three test-only
  additions noted). Standards — pass; the one hard process violation (evidence
  not keyed to the new SHA) is resolved by this file and its siblings.

Both axes ran as independent fresh-context reviewers over
`git diff f757211...HEAD`.

## Spec axis

- **(1) conflict check uses the names-only lookup** — holds.
  `supplier-opening-balance.tsx:110` passes `existingNames: suppliers.map(...)`
  where `suppliers` derives from `namesQuery` (`orpc.suppliersListNames`).
- **(2) no unconditional full-party load on that page** — holds. `suppliersList`
  appears only inside `supplierReadQueryKeys` (line 76, invalidation), never in a
  `useQuery`.
- **(3) tests cover a name folding onto an existing supplier, and two outgoing
  rows folding to one name** — both present and untouched:
  `folds a typed name onto an existing supplier from the names-only list (#183)`
  and `blocks two outgoing rows folding to one name before the server (round 5)`.
- **(4) no change to the server's resolution contract** — holds; the delta has no
  server/contract file, and `sends a typed name as newSupplierName, never a
  pre-resolved id (round 5)` still pins the client contract.

### Spec — scope beyond the Greptile gap (test-only, no blockers)

1. `blocks the save when the names read fails…` + the `namesShouldFail` mock
   flag. Not part of the Greptile gap; it pins the `listFailed` guard for the
   names seam, which `183-design.md` does spec ("a failed read blocks the save").
   **Kept** — test-audit finding #1, same #183 guarantee.
2. `requestSubmit()` in the account-failure test. **Kept** — removes a vacuous
   disabled-button click (quality finding).
3. Three key assertions added to the success-path invalidation test.
   **Kept** — closes the same untested `suppliersAccountSummaries` invalidation
   on the success path; the array that powers it is shared with the refusal path.

### Spec — "looks wrong" note, adjudicated

The reviewer flagged the refusal-test comment ("the refusal's own refresh
surfaced the history") as overstated because it rests on the dialog naming s-2.
**Refuted by the mutation log**: with the account invalidation removed, that test
failed with `Expected to contain: "مورد بلا حركات"` / `Received:` the dialog
without it — s-2 is a `filledExisting` row, so the dialog names it **only** when
the refreshed `accountEntryCount > 0` (unlike the raced test's typed draft, whose
name is listed unconditionally). The following `confirmExisting: true` payload is
a second, independent proof. The comment is accurate.

## Standards axis

No documented-standard code violations recorded. The single hard finding was a
process one:

- **`docs/engineering-workflow.md` — evidence must name the reviewed HEAD.**
  `29828a6-*` evidence predated this round. **Resolved**: the four old files were
  moved to `superseded/` and this round's `1fa457f-{guard,test-audit,code-review}.md`
  are keyed to the new SHA. (The reviewer's copy ran before these files existed.)

Positive standards evidence recorded by the reviewer: the `requestSubmit()` change
satisfies the money-gate wisdom ("gate the `save()` helper too, not only the outer
submit"); the names-failure test supplies the "fail one read while the other
succeeds" case the same wisdom mandates; the key assertions follow
`2026-10-13-refresh-derived-views-on-partial-failure`; `namesShouldFail` follows
the file's flag idiom and is reset in `beforeEach` (no leaked state).

### Fowler baseline — judgement calls

1. **Duplicated Code** — the two read-failure tests are the same five lines; a
   shared `expectBlockedWithoutRequest()` helper would remove the twin.
   **Deferred** (follow-up note). A judgement call, not a violation; extracting it
   now would churn the reviewed file for no behavioural gain and invalidate the
   Guard runs again. The rationale comment is carried on both call sites.
2. **Comment volume** — the repo's test files already narrate intent; kept
   consistent with the file.

## Verification claims

- The commit's claim ("removing the `suppliersAccountSummaries` invalidation makes
  four tests fail") is **verified**, log at
  `.scratch/reviews/183/logs/mutation-final.log`, page restored and re-checked.
- `bun test src/pages/supplier-opening-balance.test.tsx` → 25 pass / 0 fail.
- Guard 1 / Guard 2 commands and exit codes: `1fa457f-guard.md`.
