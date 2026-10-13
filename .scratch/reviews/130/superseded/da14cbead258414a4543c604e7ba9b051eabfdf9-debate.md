# #130 — Debate (critic + defender)
Reviewed HEAD: `da14cbead258414a4543c604e7ba9b051eabfdf9` (`feat-130-arabic-name-variants`)
Code reviewed at `5aa47930`; re-pinned to this HEAD — the only change since is the wisdom captured under `.agents/wisdom/` (no code change).
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, merge-base = HEAD of base)
Tier: Standard, treated as money-adjacent (a missed warning creates a second debtor).

**Method disclosure.** `feature-implement` step 6 mandates the critic/defender pair as parallel
sub-agents. This lane has no sub-agent tool (its toolset is read/bash/grep/find/ls plus the
supervisor channel), so both lenses were run in-lane against the pinned diff, in the order the
skill defines: critic first (harsh, severity-scored), then the defender's case for each decision.
Round 1 ran at `57acb32`; the fixes below are in the reviewed HEAD. The parent should treat the
sub-agent fanout as still owed for the fold's false-positive rate if it wants a second independent
pair of eyes (the Greptile CLI gate is also unavailable here, see below).

## Round 1 — critic findings (at `57acb32`)

| # | Sev | Finding (file) | Resolution in reviewed HEAD |
| --- | --- | --- | --- |
| F1 | 5 | `foldArabic` also drops the leading «ال», so «السعيد»/«سعيد» and «الحمد»/«حمد» warn as one person — a widening #130 never asked for. `party-match.ts` | **Fixed**: the warning key is the article-preserved half, `foldArabicVariants(name)[1]`; unit test pins both pairs as distinct. |
| F2 | 4 | `parties.find(...)` returned the first folded match in list order, so with an earlier variant spelling present the warning named (and its one-click button picked) the wrong record. `party-match.ts` | **Fixed**: the identical spelling is preferred, then the first variant; unit test pins both list orders. |
| F3 | 3 | The e2e cleanup ran at the end of the test body, so a mid-test failure left two parties in the shared e2e DB (later specs assert global totals). `customer-name-variants.spec.ts` | **Fixed**: cleanup moved to `test.afterEach`, mirroring `customers.spec.ts`. |
| F4 | 2 | The e2e step "the list already offers the stored record" passes even if the duplicate warning never fires, because #165's fuzzy fallback surfaces the row — non-discriminating evidence. | **Fixed**: the step was dropped; the search fold on the picker list is #165's already-covered behaviour (`tests/e2e/arabic-search.spec.ts`). |
| F5 | 2 | The warning did not fire when neither side had a phone, which is the common walk-in — the exact scenario the issue describes would still slip through. | **Fixed**: the phone-equality exemption is limited to the IDENTICAL spelling (the `needsChoice` case); a variant spelling with no phone on either side now warns. Unit + e2e (the e2e seeds a phoneless customer) pin it. |
| F6 | 2 | `duplicateNameParty` folds the loaded customer list on every keystroke while the create panel is open; no memoization. | **Accepted, not fixed**: only runs with the panel open (a closed panel early-returns on the empty candidate), `customersList` returns the whole list either way, and pre-#130 code did the same walk with `normalizeTextKey`. Memoizing folded names is a performance follow-up, not a #130 requirement. |
| F7 | 1 | Doc sentence "the warning folds the same way" was loose about the article and the substring-vs-equality difference. | **Fixed**: design doc rewritten (`Reuse: the letters-only half of the #165 fold`), and the `foldArabicVariants(...)[1]` choice is documented at the call site. |

## Round 2 — defender's case, kept

- **Narrowest rule that satisfies the issue**: exact folded equality only (no `fuzzySearchScore`),
  and the article kept — so «محمد»/«محمود» and «السعيد»/«سعيد» stay two people. Confidence 9/10.
- **The warning stays a warning**: `createDisabled` is untouched, `needsChoice` still uses
  `normalizeTextKey`, and the component + e2e tests both assert the save button is enabled and the
  second record really is created. Confidence 9/10.
- **ADR-0007 boundary holds**: `normalizeTextKey`, storage, `phoneMatchParty` and the store's
  unique-phone rule are unchanged; the extended identity-guard test asserts the strict key stays
  strict while the advisory warning folds. Confidence 9/10.
- **Copy is honest**: «بالاسم نفسه» → «باسم مشابه» because a folded match may be a different
  spelling; the sentence that keeps the deliberate second record available is retained. 8/10.
- **Reuse is real**: nothing was added to `packages/contracts`; the diff does not touch any other
  caller of the fold. Confidence 10/10.

## Dismissed / deferred

- Dismissed: "folding the warning at all violates ADR-0007" — the ADR governs identity and debt
  grouping, not an advisory nudge; the identity key and storage are untouched.
- Deferred (out of scope, no follow-up issue raised by this lane): the `/customers` create form
  has no duplicate-name warning at all; a warning mounted inside a `role="status"` region may not
  be announced by every screen reader (pre-existing markup).
- Deferred to the parent: Greptile. `greptile whoami` → `error: refresh failed: access_denied`,
  and `greptile review --json --branch develop` → `error: this review is too large to send` (the
  known large-diff trap, `.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`). The hosted PR
  path is the documented workaround, but this lane must not push.
