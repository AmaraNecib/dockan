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
second customer (a second debtor) for the same person.

## Reuse: `foldArabic` (#165)

**Reused, not re-invented:** `foldArabic` from `packages/contracts/src/arabic-search.ts`
(#165). It already covers every variant #130 names:

- alef: `آ أ إ ٱ ٲ ٳ → ا`
- ya / alef maqsura: `ى ئ → ي`
- (plus `ة → ه`, `ؤ → و`, harakat/tatweel/bidi/zero-width stripping, punctuation
  and separators as word breaks, and a guarded leading-«ال» drop)

Nothing was added to the fold, so no other caller changes. `foldArabic` is used
at **exact folded equality** (not substring, not fuzzy), which is the narrowest
rule that satisfies the issue.

Why this fold and not a purpose-built name key: the picker's list filter
(`filterParties`) already matches names with this fold (`arabicIncludes`). The
warning is strictly narrower than the filter (exact folded equality vs folded
substring), so a record the owner can see in the list under the same spelling
cannot warn while the list hides it. Sharing the fold keeps one spelling rule
for the picker instead of two.

## Interfaces

No new public API. One changed function in
`apps/web/src/components/parties/party-match.ts`:

```ts
/** A party whose name folds to the same key as the candidate's but whose phone
 * differs; the picker warns before it creates a second debtor (#130). */
export function duplicateNameParty(
  name: string,
  phone: string | null,
  parties: readonly PartyLike[],
): PartyLike | undefined;
```

- `normalizeTextKey(name)` → `foldArabic(name)` for the name key (both sides).
- The phone half is unchanged: a same-folded-name record carrying the **same**
  phone is the same identity (the store refuses a duplicate phone), so it never
  warns — `phoneMatchParty` already offers that record.

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

## Planned tests

*Unit — `apps/web/src/components/parties/party-match.test.ts`:*

1. warns across alef (`أحمد`/`احمد`), ya/alef-maqsura (`مصطفى`/`مصطفي`), and the
   issue's own case (`على علي`/`علي علي`);
2. **false-positive guards** (the dangerous direction): names differing by a real
   letter stay distinct (`محمد`/`محمود`, `عمار`/`عمر`, «علا علي»/«علي علي»);
3. same folded name **and** same phone → no warning (same identity);
4. empty/whitespace candidate → no warning;
5. the #165 guard test is updated: `normalizeTextKey("أحمد") !== normalizeTextKey("احمد")`
   still holds (identity untouched) while the warning now fires.

*Unit — `apps/web/src/components/parties/party-picker.test.tsx`:*

6. typing «على علي» against a stored «علي علي» (different phone) shows the
   warning and still lets the owner save — the created record is the variant
   spelling;
7. typing that variant does **not** set `needsChoice` (warning, not a block).

*E2E — `tests/e2e/customer-name-variants.spec.ts` (new, shared DB, `workers: 1`):*

8. seed «علي علي-<stamp>» with a phone, type «على علي-<stamp>» in the sale
   picker: the list already offers the stored record, the create panel warns,
   the save button is enabled, and the second record is created;
9. the /customers list then holds both spellings as **two** records with zero
   invoices each (the warning did not merge or block);
10. negative control: «علا علي-<stamp>» (one real letter different) does **not**
    warn — the fold did not widen past letter variants;
11. cleanup: both zero-invoice records are deleted so the shared e2e DB is
    returned to its prior state (no global-count drift for later specs).

## Risks

| Risk | Mitigation |
| --- | --- |
| **Over-folding**: two different people warn as one | Exact folded equality only (no fuzzy edit distance); letter-distinct guards in unit + e2e; the warning never blocks, so a false positive costs one nudge, not a merged balance. |
| Article drop (`ال` prefix) merging «السعيد»/«سعيد» | Accepted for a *warning*: in Algerian naming the «ال» is a stylistic prefix on the same name, and #165 already folds it for the picker's list. Pinned by tests; identity keeps them apart. |
| ADR-0007 drift (identity key silently folding) | `normalizeTextKey` and `needsChoice` untouched; the existing identity-guard test stays and is extended to assert both halves at once. |
| Emptiness: a key that matches everything | `foldArabic("")` (and punctuation-only) is `""` → the `nameKey === ""` early return is kept. |

## Dependencies

None added; `foldArabic` is already exported by `@dokan/contracts`.
