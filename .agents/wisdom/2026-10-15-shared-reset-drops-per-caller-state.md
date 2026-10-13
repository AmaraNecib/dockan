# A shared reset silently drops the state one caller was keeping

**Date:** 2026-10-15 · **Ticket:** 146 (PR #188, Greptile round 1) · **Area:** apps/web/src/lib/use-invoice-draft.ts, quick-add

Extracting the purchase and sale quick-add forms into one hook, the shared
"success" path reset the whole field bag:

```ts
setFields(spec.empty());
```

Purchase's old handler cleared the item fields and deliberately kept one:

```ts
setQuickName(""); setQuickBarcode(""); setQuickSellPrice("");
setQuickThreshold(""); setQuickQty("1"); setQuickUnitCost("");
// quickCategoryId deliberately NOT cleared
```

So the owner could stock several items from one category pick. After the
extraction they had to re-pick it for every item, or the create stopped with
`itemsChooseCategory`. Greptile caught it at 4/5, one round later, because the
diff reads as a tidy reset and the lost field lives on the *other* side of the
seam.

The class of bug: a shared reset is written from the union of what the callers
clear, and nothing in the code says which fields each caller *kept*. The
extraction looks complete because the field still exists in the bag; it is only
never populated again.

**Always**: when a shared lifecycle step (reset, close, clear, retry) replaces
per-caller code, write out a field-by-field table of old handler versus new
behaviour for every caller before you believe the extraction is done. Then make
the policy declarative and required, so the next caller has to answer it:
`keepOnCreate: readonly (keyof F)[]` on the spec, with the reset built as
`{ ...empty(), ...declared }`. Pair the reset with a test that does the owner's
action twice in a row (create two items from one pick) and one that falsifies it
by emptying the keep list. A required declaration only forces an answer, so the
test is what actually holds the behaviour.
