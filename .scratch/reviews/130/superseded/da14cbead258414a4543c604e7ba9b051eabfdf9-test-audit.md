# #130 — Test audit
Reviewed HEAD: `da14cbead258414a4543c604e7ba9b051eabfdf9` (`feat-130-arabic-name-variants`)
Code reviewed at `5aa47930`; re-pinned to this HEAD — the only change since is the wisdom captured under `.agents/wisdom/` (no code change).
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`)
Tier: Standard. Method: the skill's three lenses (edge-case hunter, coverage analyst, test-quality
reviewer) run in-lane against the pinned diff — see the method note in `-debate.md` (no sub-agent
tool in this lane).

## Verdict

**A− — no blockers, no RED findings.** Every acceptance criterion in #130 has a behaviour-level
test at the level where it can fail, and the dangerous direction (over-folding) has both a unit and
an E2E negative control.

## Acceptance-criteria coverage

| Criterion (#130 / brief) | Test | Level | Verdict |
| --- | --- | --- | --- |
| Fold alef forms (`ا/أ/إ/آ`) in the duplicate check | `party-match.test.ts` "warns across alef, ya and alef-maqsura spellings" (`احمد بنين` vs `أحمد بنين`); `arabic-search.spec.ts` for the search side | unit | adequate |
| Fold ya / alef maqsura (`ي/ى`) | same test (`علي علي` vs `على علي`, `مصطفي` vs `مصطفى`) | unit | adequate |
| «على علي» vs «علي علي» warns | unit + `party-picker.test.tsx` (warning shown, stored spelling + phone in the text) + `customer-name-variants.spec.ts` (real UI) | unit + component + E2E | adequate |
| Two genuinely different names do NOT warn | unit "keeps names that differ by a real letter apart" (`محمد`/`محمود`, `علا علي`/`علي علي`, `مصطفى نور`, `عماد`) + "keeps a leading «ال» significant" (`السعيد`/`سعيد`, `الحمد`/`حمد`) + E2E negative control `علا علي-<stamp>` | unit + E2E | adequate |
| Warning, not a hard block: the owner can still create | unit "prefers the exactly spelled record" (no block semantics in the fn), component (save enabled, `created` records the variant spelling, `needsChoice` stays `ok`), E2E (save enabled, value = variant spelling, two rows exist) | component + E2E | adequate |
| Warning copy is Arabic via i18n; no display text from the API | component test asserts the rendered `picker-duplicate` text contains the stored name AND the phone, i.e. the i18n template rendered | component | adequate |
| Storage keeps the owner's spelling | component asserts the create payload is the typed spelling; E2E asserts the created row keeps it (`party-row` filter by the variant) | component + E2E | adequate |
| Identity / identity key unchanged | `party-match.test.ts` "keeps the identity key strict while the duplicate warning folds" (`normalizeTextKey("أحمد") !== normalizeTextKey("احمد")`) | unit | adequate |

## Findings and resolutions

| Finding (lens) | Risk | Resolution |
| --- | --- | --- |
| No test for the common phoneless walk-in (edge case): a stored phoneless «علي علي» vs typed «على علي» used to be exempted by the phone rule | ORANGE | Rule fixed (exemption limited to the identical spelling) + unit test "warns for a variant spelling even when neither side has a phone" + the E2E seeds a phoneless customer |
| With two records — an earlier variant and the exact spelling — no test pinned which one the warning names (and picks) | ORANGE | Unit test "prefers the exactly spelled record over an earlier variant of the name" pins both list orders |
| Article-prefixed names («السعيد»/«سعيد») were untested while the fold could have merged them | ORANGE | Unit test "keeps a leading «ال» significant" |
| No E2E negative control (positive-only evidence) | ORANGE | E2E step 4 asserts `sale-customer-duplicate` has count 0 for `علا علي-<stamp>` |
| Tashkeel and the empty-key edges (harakat-only candidate, a stored name that folds to nothing) were unpinned for the new key | YELLOW | Added to the unit tests ("...and tashkeel ..." and "never warns for a candidate that folds to nothing") |
| E2E cleanup ran inside the test body only | ORANGE | Moved to `test.afterEach` (failure-safe, mirrors `customers.spec.ts`) |
| An E2E step passed for the wrong reason (the #165 fuzzy fallback surfaces the row whether or not the warning fires) | YELLOW | Step dropped; the search fold is #165's covered behaviour |

Duplicate/tautological coverage: none found — no assertion recomputes the fold, and the negatives
would fail if the key were too wide (they are the mirror of the positives). No test reaches into
internals: all assertions go through the exported matcher, the rendered component, or the real UI.

## Remaining notes (accepted, no blocker)

- Arabic-Indic digits inside a **name** are not folded (a stored «علي ٠٥»/typed «علي 05» does not
  warn). Same accepted gap #165 recorded for search; phone matching already folds them.
- The warning's `role="status"` region is mounted with its content rather than filled after mount,
  so not every screen reader announces it. Pre-existing markup (the phone-owner alert is the same),
  out of #130's scope.
- `duplicateNameParty` folds the list per keystroke while the create panel is open (performance,
  not correctness) — see debate F6.

## Commands

```
bun run typecheck                     # exit 0 (3 tasks)
bun run lint                          # exit 0 (oxlint)
bun run test --force                  # exit 0 — web 856 pass / 0 fail (67 files)
bun test (apps/api)                   # exit 0 — api 827 pass / 0 fail (42 files)
bun run test:e2e                      # exit 0 — 56 passed (3.9m), includes the new spec
bun run test:e2e tests/e2e/customer-name-variants.spec.ts   # exit 0 — 1 passed (9.1s)
```
