# #130 — Test audit, review-fix round 1

Reviewed HEAD: `791070a2ca46efa23e366f2effd05596f1f4aabb` (`feat-130-arabic-name-variants`, PR #189)
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`)
Tier: Standard. Method: three independent parallel lenses (`oracle`) against
`d967295369946c98d6c317456428a6431e9c72d5`, focused on the question the parent
asked: **would the spec still pass if the feature were broken?** Findings were
applied and re-verified at this HEAD.

## Verdict

**Pass after fixes — no RED findings.** The E2E now fails on the exact bug class
this round fixes, and the cleanup can no longer pass vacuously.

## Broken-feature matrix (coverage lens, verified)

| Step | fold removed | warning never rendered | warning blocks | cleanup skips | delete unasserted |
| --- | --- | --- | --- | --- | --- |
| 2 warning text (`storedName` + «بلا هاتف») | **FAIL** | **FAIL** | — | — | — |
| 2 needs-choice count 0 | pass | pass | **FAIL** | — | — |
| 2 save enabled + created value | pass | pass | **FAIL** | — | — |
| 3 two rows (stored + variant) | **FAIL** | FAIL | FAIL | — | — |
| 4 both spellings stored, exact typed → no warning | **FAIL** (new step; verified red against `14f0a0d`) | FAIL | — | — | — |
| 5 negative control (real letter) | **FAIL** | FAIL | — | — | — |
| afterEach | — | — | — | **FAIL** (end-of-hook re-read) | **FAIL** (`toHaveCount(0)`) |

Unit/component mutation checks (lens 2, re-derived): removing the fold fails the
alef/ya/maqsura and `#165` guard tests; over-folding fails the real-letter and
«ال» tests; reverting the early return fails both the unit regression test and the
component seam test (**verified red at `14f0a0d`, green at this HEAD**); folding
the hard gate fails `choiceState`/identity assertions; dropping the phone-identity
exemption fails the same-phone tests.

## Findings and resolutions

| Finding | Risk | Resolution |
| --- | --- | --- |
| **The E2E could not fail on the bug class this round fixes** — the spec seeded only one stored spelling, so the phoneless-exact + phoneless-variant wrong-debtor regression passed on the broken build | ORANGE | **Fixed**: step 4 seeds both phoneless spellings (step 2 already creates the second), types the exact one, asserts the identity gate is visible and the duplicate panel is absent. Verified red against `14f0a0d` (1 failed at `sale-customer-duplicate` count) and green after. |
| The cleanup never proved the **server** lost the record — an acked POST plus an optimistic row removal would pass | ORANGE | **Fixed**: the hook re-reads `customersList` after the loop and asserts neither name is returned, which also turns a silently skipped name into a failure. |
| Cleanup presence compared names with exact string equality (a server-side trim/normalization would silently skip) | ORANGE | **Mitigated**: the end-of-hook re-read fails loudly on any skip, and the names are the spec's own unique stamps. |
| Branch-1 recognition pinned only for clean spellings | ORANGE | **Fixed**: bidi-mark and tashkeel-typed candidates added (they must hit the identity key, not the folded one). |
| The picker test stopped before opening the create panel, so a regression clearing `needsChoice` on open would pass | ORANGE | **Fixed**: the panel-open assertions now re-check the gate. |
| The loop's doc dropped the "shared phone is skipped, so a variant of it still warns" case | YELLOW | **Fixed**: behaviour pinned and the doc sentence restored. |
| Tie-breaks, spaced phones, empty/one-record lists untested | YELLOW | **Fixed** for tie-break (both orders) and the spaced `+213 555 123 456` same-phone form. |
| No supplier path in the E2E cleanup | YELLOW | **Accepted**: component-level supplier coverage exists and the cleanup only ever handles customer names by construction. |
| Step 3 proves two *records*, not two *debtors* | YELLOW | **Accepted** (unchanged from the previous round): a merged balance requires a merged record, which the two-row assertion fails on. |

## Grades

`party-match.test.ts` **A** (after splitting the bundled test into focused specs)
· `party-picker.test.tsx` **A** (pins the wrong-debtor contract at the seam the
bug crossed) · `tests/e2e/customer-name-variants.spec.ts` **A−** (discriminating in
both directions; the cleanup's correctness is now asserted in-spec, and I also
confirmed the shared DB is left with zero of this spec's customers after a full
run via SQLite).

## Commands

```
bun run typecheck                  # exit 0
bun run lint                       # exit 0
bunx turbo test --force            # exit 0 — web 863 pass / 0 fail, api 827 / 0, desktop 57 / 0
DOKAN_PORT=4731 DOKAN_WEB_PORT=5731 bun run test:e2e
                                   # exit 0 — 56 passed (full suite, isolated ports)
DOKAN_PORT=4731 DOKAN_WEB_PORT=5731 bun run test:e2e tests/e2e/customer-name-variants.spec.ts
                                   # exit 0 — 1 passed (and exit 1 with 14f0a0d's source, proving the new step discriminates)
```
