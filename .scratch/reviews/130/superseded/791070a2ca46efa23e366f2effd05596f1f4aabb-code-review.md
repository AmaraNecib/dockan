# #130 — Code review, review-fix round 1 (Standards + Spec)

Reviewed HEAD: `791070a2ca46efa23e366f2effd05596f1f4aabb` (`feat-130-arabic-name-variants`, PR #189)
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`)
Previous reviewed HEAD: `14f0a0d9b9e812adb2cbd0c2b53d1327a5fb2f3d`
Method: two independent axes as parallel sub-agents (`oracle`) against
`829f60e1ae6dfe0c82d0d592a777978bf93028f2`; the follow-up findings were applied
and re-verified at this HEAD.

## Standards

**Verdict: pass after fixes.** One hard finding, in the record rather than the
code:

| Finding | Status |
| --- | --- |
| The design doc described an intermediate cleanup mechanism ("waits for the table-or-empty state") that the committed code never had — `docs/engineering-workflow.md` makes the design the record of what was built | **Fixed**: the design doc now describes the shipped mechanism (acked payload for presence, `toHaveCount(1)` before / `toHaveCount(0)` after each deletion, end-of-hook server re-read) and the round-1 tests |
| **Duplicated Code / Primitive Obsession**: the `{ items: Array<{ name: string }> }` shape and the three-line `customersList` read appeared three times in the spec | **Fixed**: one `CustomerListPayload` type and one `readCustomers(page)` helper, used by step 1 and both cleanup reads |
| **Divergent Change (test cohesion)**: one `it` bundled five scenario groups, so a failure reported only a coarse name | **Fixed**: split into the suppression spec, the shared-phone-skip spec, and the tie-break spec |
| **Mysterious Name**: `let variant` meant "first folded match that is not the identity" | **Fixed**: renamed `variantMatch` |
| **Consistency note**: the spec's loaded-list idiom (acked payload) differs from `customers.spec.ts`'s table-or-empty wait | **Accepted, documented**: the payload version is strictly stronger (it is the data the assertions use) and the helper's doc comment says why |

ADR-0007 boundary intact: `normalizeTextKey` is used for the identity checks only,
`foldArabicVariants[1]` only for the warning key, and `arabic-search.ts` still
documents itself as search-only with the #130 consumer named. No artifacts
staged; `.dokan-port` restored after each e2e run.

## Spec

**Verdict: pass.** All three review-fix requirements are satisfied, plus the
original issue's scope:

- **(1) Exact phoneless record** — `party-match.ts` returns `undefined` on the
  candidate's exact phoneless spelling before the variant fallback can run; the
  regression test fails when reverted (verified red at `14f0a0d` at unit,
  component **and** E2E level).
- **(2) Cleanup awaits the list read** — presence comes from the acked
  `customersList` payload; the pending-render trap is gone.
- **(3) Per-deletion `actAndAck` + row disappearance** — each `customersDelete` is
  awaited and the filtered row must reach count 0; a final re-read proves the
  server end state. No notice-based assertion remains.
- **Original spec** — alef/ya folding for the picker's warning, warning-only
  (save stays enabled), Arabic copy via i18n with no API display text, storage
  untouched (no `apps/api` diff), the #165 fold reused with the article-preserving
  half and the reason recorded, and negative controls against over-folding at all
  three levels.
- **Out of scope, untouched** — `receipts.spec.ts` (#191); the CI failure on PR
  #189 was that spec, not this branch.

Disclosed boundaries (unchanged): the warning renders only inside the inline
create panel, so a typed-only variant submit is still unnudged (folding the hard
`needsChoice` gate would create the block the issue forbids); suppliers inherit
the shared warning deliberately; a warning inside a `role="status"` region may not
be announced by every screen reader (pre-existing markup).

## Landing note

`origin/develop` is ahead of the PR base with #181 (no file overlap with this
diff). The branch is pushed (PR #189); this round adds commits on top — no amend,
rebase or force-push.

## Commands

```
git diff fc951133134a9b0b18b5ae38f9658665c29e73ec...791070a2ca46efa23e366f2effd05596f1f4aabb
bun run typecheck && bun run lint   # exit 0
```
