# Phone identity boundary: validate the change and share the cleaner

**Date:** 2026-10-15 · **Issue:** #129 · **Area:** packages/contracts, apps/api
store/router, apps/web party forms/picker, tests/e2e

Issue #129 refused non-numeric phone text at the party-identity boundary.

## Gate a form-side identity rule on "changed", not on "present" (🟠 Major)

The first cut validated the phone field at the top of `PartyForm.submit`, before
the existing "submit only what changed" diff. That is correct for a new value and
wrong for an old one: a record already holding junk (`"abc"`, exactly the rows
this issue exists to clean up) rendered the junk back into the field, and a
name-only edit was refused with "must be numbers" — a regression on the very data
the fix targets. The store was right (it validates only a `patch.phone !==
undefined`), so the bug lived entirely in the UI ordering.

**Always**: when a UI re-validates a value before an update, compare against the
stored canonical value first and validate only when it actually changed. The
store boundary and the form boundary must apply the same rule to the same set of
values, or one of them blocks a legitimate operation.

## Share the cleaner between the predicate and the canonicalizer (🟡 Minor)

`isPartyPhoneText` initially copy-pasted `normalizePartyPhone`'s cleaning steps
(fold Arabic-Indic digits, strip invisible bidi marks, strip
space/dot/parens/dash). Wisdom `identity-keys-and-backfill.md` records
that this exact cleaning drifted before, splitting one identity into two. Extract
one `cleanPhoneText` and call it from both the predicate and the canonicalizer;
a separator added to one path and not the other is an identity-split bug in the
code that exists to prevent splits.
