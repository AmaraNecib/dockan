# A soft duplicate warning needs its own key — narrower than search, wider than identity (🟡 Major)

Issue #130: the picker's duplicate-name warning matched names with `normalizeTextKey` (ADR-0007
identity key), so «على علي» never warned against a stored «علي علي» and a second debtor was created
silently. The tempting fix is to reuse the #165 search key `foldArabic`. That was wrong: `foldArabic`
also drops a leading «ال», so it flags «السعيد»/«سعيد» and «الحمد»/«حمد» — real family-name
differences in Algeria. Review caught it (severity 5) before merge.

The repo now has three deliberate name keys, and a new rule must pick the right rung:

| Rung | Key | What it keeps apart | Used by |
| --- | --- | --- | --- |
| Identity | `normalizeTextKey` | «أحمد»/«احمد», «السعيد»/«سعيد» | storage, the store's unique phone, the picker's `needsChoice` hard gate |
| Soft warning | `foldArabicVariants(name)[1]` (letters only, article KEPT) | «السعيد»/«سعيد», «محمد»/«محمود» | the duplicate-name warning |
| Search | `foldArabic` / `arabicIncludes` (article dropped, substring, fuzzy fallback) | only genuinely different words | catalog + party list filters |

**Always**: for a soft nudge that a human can override, take the narrowest existing key that
satisfies the ticket — never the search key, and never a fuzzy/edit-distance score
(`fuzzySearchScore` would merge «محمد»/«محمود»). Two further rules earned by this lane: prefer the
EXACT spelling among folded matches, because the warning's one-click pick must select the record the
owner typed rather than an earlier variant of it; and exempt only the truly-same identity (the same
phone, or the identical spelling with no phone on either side), not "different phone or no phone" —
otherwise the common phoneless walk-in keeps slipping through.

**Always**: pin the dangerous direction as a test, not the happy path. Over-folding merges two
people's debts, so the negative controls (`محمد`/`محمود`, `علا`/`علي`, `سعيد`/`السعيد`, one E2E
negative) are the tests that protect the money.
