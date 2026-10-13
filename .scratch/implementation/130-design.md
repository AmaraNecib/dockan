# #130 — Customers: Arabic name-variant duplicate warning in the picker

**Tier:** Standard (UI warning), but money-adjacent: a missed warning creates a
second debtor, so the matching rule is proven by tests and reviewed for
over-folding (a false positive that swallowed two people into one record would
merge their debts).
**Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec` (merge-base = HEAD).
**Branch:** `feat-130-arabic-name-variants`.

## Problem

`duplicateNameParty` compares names with `normalizeTextKey` (identity key,
ADR-0007), which strips diacritics/tatweel/bidi but keeps letter forms. So
«على علي» does not warn against a stored «علي علي», «احمد» does not warn against
«أحمد», «مصطفي» does not warn against «مصطفى» — and the owner silently creates a
second customer (a second debtor) for the same person. The same holds for the
common walk-in with no phone on either side.

## Reuse: the letters-only half of the #165 fold

**Reused, not re-invented:** the fold in
`packages/contracts/src/arabic-search.ts` (#165), at the **article-preserved**
half — `foldArabicVariants(text)[1]` (letters folded, leading «ال» kept). It
already covers every variant #130 names:

- alef: `آ أ إ ٱ ٲ ٳ` → `ا`
- ya / alef maqsura: `ى ئ` → `ي`
- (plus `ة → ه`, `ؤ → و`, harakat/tatweel/bidi/zero-width stripping, punctuation
  and separators as word breaks)

Nothing was added to the fold, so no other caller changes.

Why the article-preserved half and not `foldArabic`: `foldArabic` also drops a
leading «ال» per word, which would flag «السعيد»/«سعيد» and «الحمد»/«حمد» —
recorded family names in Algeria, i.e. potentially two different people. #130
asks for alef/ya folding only, so the warning keeps «ال» significant (pinned by
unit tests). The warning is therefore deliberately narrower than the picker's
list filter (`arabicIncludes`, which matches substrings and article variants
too).

The rule is **exact folded equality**, never edit distance: the #165 fuzzy
fallback would make «محمد»/«محمود» warn, and those are different names.

## Interfaces

No new public API. One changed function in
`apps/web/src/components/parties/party-match.ts`:

```ts
/** A likely-same party the picker warns about before it creates a second
 * debtor (#130). Advisory only. */
export function duplicateNameParty(
  name: string,
  phone: string | null,
  parties: readonly PartyLike[],
): PartyLike | undefined;
```

- The name key is `nameVariantKey` = `foldArabicVariants(name)[1]` (a named
  local helper, so the choice of the article-preserved half is documented where
  it is used).
- The **identical spelling** (still `normalizeTextKey`) is preferred over an
  earlier variant of the name, so the warning's one-click pick selects the
  record the owner typed.
- Not a duplicate when the two records are one identity: the **same phone** (the
  store refuses a second owner; `phoneMatchParty` already offers that record), or
  the **same spelling with no phone on either side** (a walk-in re-typing her own
  name — the picker's `needsChoice` gate already refuses that one).
- Everything else that folds to one key warns, including a variant spelling when
  neither side has a phone.

## Deliberate non-changes

| Untouched | Why |
| --- | --- |
| `normalizeTextKey` (ADR-0007 identity key) | Identity still keeps «أحمد»/«احمد» apart; only the advisory warning folds. Storage keeps the owner's spelling. |
| The picker's `needsChoice` hard gate | That gate forces the owner to pick an existing record and refuses a typed-only name. Folding it would turn the new warning into a hard block and would let a variant spelling refuse a deliberate second customer. |
| `phoneMatchParty` / the store's unique phone | Identity, unchanged. |
| Name **storage** (`createParty`) | The owner's spelling is preserved; this is a matching rule only. |
| `filterParties` | Already folds (#165). |

Non-goal (recorded, not built): the `/customers` new-party form
(`party-forms.tsx`) has no duplicate-name warning at all today; #130 scopes the
picker. The supplier picker shares this code path and therefore gets the same
warning — same debtor-splitting risk, no extra code.

## Copy

`apps/web/src/lib/i18n.ts` → `partyDuplicateName`: «بالاسم نفسه» → «باسم مشابه»,
because a folded match can be a different spelling of the same name. The
sentence that keeps the second record available («إن لم يكن الشخص نفسه فأنشئ
سجلاً ثانياً») stays: it is the "warning, not a block" affordance. Arabic via
i18n only; no display text from the API.

A second key, `partyDuplicateNameNoPhone`, covers a stored record with no phone
— the walk-in case #130 now warns about. Without it the copy read «باسم مشابه
«علي علي» برقم مختلف (بدون هاتف)»: "a different phone (no phone)".

## Planned tests

*Unit — `apps/web/src/components/parties/party-match.test.ts`:*

1. warns across alef (`أحمد`/`احمد`), ya/alef-maqsura (`مصطفى`/`مصطفي`), and the
   issue's own case (`على علي`/`علي علي`), plus the free ta-marbuta pair
   (`عمارة`/`عماره`);
2. **false-positive guards** (the dangerous direction): names differing by a real
   letter stay distinct (`محمد`/`محمود`, `عمار`/`عمر`, «علا علي»/«علي علي»), and a
   leading «ال» stays significant (`السعيد`/`سعيد`, `الحمد`/`حمد`);
3. same folded name **and** same phone → no warning (same identity);
4. a variant spelling with **no phone on either side** → warns (walk-in case),
   while the identical phoneless spelling → no warning (`needsChoice` case);
5. the exact spelling wins over an earlier variant of the name, in both list
   orders;
6. empty/punctuation-only candidate → no warning;
7. the #165 guard test is updated: `normalizeTextKey("أحمد") !== normalizeTextKey("احمد")`
   still holds (identity untouched) while the warning now fires.

*Unit — `apps/web/src/components/parties/party-picker.test.tsx`:*

8. typing «على علي» against a stored «علي علي» (different phone) shows the
   warning, names the stored spelling and its phone, and still lets the owner
   save — the created record is the variant spelling;
9. typing that variant does **not** set `needsChoice` (warning, not a block).

*E2E — `tests/e2e/customer-name-variants.spec.ts` (new, shared DB, `workers: 1`):*

10. seed «علي علي-<stamp>» with **no phone** (the walk-in), type «على علي-<stamp>»
    in the sale picker: the create panel warns, the save button stays enabled,
    and the second record is created;
11. the /customers list then holds both spellings as **two** records (the warning
    did not merge or block);
12. negative control: «علا علي-<stamp>» (one real letter different) does **not**
    warn — the fold did not widen past letter variants;
13. cleanup runs in `test.afterEach`, so the shared e2e DB is returned to its
    prior state even when the test fails part-way (mirrors `customers.spec.ts`).

## Risks

| Risk | Mitigation |
| --- | --- |
| **Over-folding**: two different people warn as one | Exact folded equality only (no fuzzy edit distance); the article is NOT dropped, so «السعيد»/«سعيد» stay distinct; letter-distinct guards in unit + e2e; the warning never blocks, so a false positive costs one nudge, not a merged balance. |
| Warning points at the wrong record (an earlier variant of the name) | The exactly spelled record is preferred; the one-click pick then selects the record the owner typed. |
| A missed warning when nobody has a phone | The phone-equality exemption applies only to the **identical** spelling (the `needsChoice` case); a variant spelling with no phone on either side now warns. |
| ADR-0007 drift (identity key silently folding) | `normalizeTextKey` and `needsChoice` untouched; the existing identity-guard test stays and is extended to assert both halves at once. |
| Emptiness: a key that matches everything | `nameVariantKey("")` (and punctuation-only) is `""` → the `foldedKey === ""` early return is kept. |

## Dependencies

None added; `foldArabicVariants` is already exported by `@dokan/contracts`.

## Review-driven changes (debate round 1 at `57acb32`, test audit at `e750327`)

- **Article drop removed from the warning key** (critic F1, severity 5):
  `foldArabic` → `foldArabicVariants(...)[1]`, so «ال» stays significant.
- **Exact spelling preferred** (critic F2, severity 4): the warning used to name
  the first folded match in list order, which could be an earlier variant
  spelling of the same name.
- **Phoneless variant now warns** (critic F5, severity 2): the identity
  exemption is limited to the identical phoneless spelling.
- **E2E cleanup moved to `test.afterEach`** (critic F3) and the
  non-discriminating "list offers the record" step dropped (critic F4: the #165
  fuzzy fallback made it pass for the wrong reason).
- **Copy contradiction fixed** (test-audit edge-case lens, ORANGE): a stored
  phoneless record rendered as «برقم مختلف (بدون هاتف)»; now
  `partyDuplicateNameNoPhone`, pinned by the E2E.
- **Missing tests added** (test-audit lenses): the warning's one-click pick
  resolving to the existing debtor, a component-level negative (real letter),
  the supplier half of the shared picker, alef inside an article-prefixed name,
  a hyphen separator, substring/word-order negatives, and the Arabic-Indic
  spelling of the same phone.
- **Accepted, not fixed**: `duplicateNameParty` folds the loaded list on each
  keystroke while the create panel is open (critic F6, severity 2). It only runs
  with the panel open, `customersList` returns the whole list either way, and the
  pre-#130 code did the same walk with `normalizeTextKey`; memoizing the keys is
  a performance follow-up, not a #130 requirement.
- **Dismissed**: "the E2E proves two list rows, not two debtors" (test-audit
  coverage lens). Two rows with the two spellings IS two records, each with its
  own invoice count and remaining; a balance merge requires merging the records,
  which the two-row assertion fails on. The existing `customers.spec.ts` already
  proves the debts screen groups by `counterparty_id`, and the new component test
  proves the warning's button selects the existing record.
- **Deferred**: the `/customers` create form still has no duplicate-name warning
  at all, and a warning mounted inside a `role="status"` region may not be
  announced by every screen reader (pre-existing markup, both out of #130's
  scope).
