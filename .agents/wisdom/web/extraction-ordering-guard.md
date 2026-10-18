# Extracting an ordering rule re-arms its bug one level up unless the payload keeps a guard (🟠 Major)

**Date:** 2026-10-15 · **Ticket:** 198 · **Area:** apps/web/src/lib/invoice-draft.ts, sale/purchase submit

Ticket 198 moved the sale/purchase submit check order — empty cart → party →
per-line (override before quantity) → discount → payment — out of two verbatim
comment blocks into one `firstCommitError` helper. The extraction itself was
fine. What nearly slipped was the *payload*:

Before, each page spelled the payment check out:

```ts
if (!paid.ok) { setError(...); return; }
...
initialPaid: paid.paid
```

The explicit `if` made TypeScript narrow `paid` to the ok arm, so the payload
could not read a rejected resolution. After the move, the page only hands
`payment: { invalid: !paid.ok }` to the helper and then needs `paid.paid` —
the narrowing is gone. The first version used
`const initialPaid = paid.ok ? paid.paid : undefined`. A reviewer caught the
hole: if a later edit weakens the payment slot, that ternary silently sends *no*
initial payment, i.e. books the whole invoice as debt — the same class of bug
the extraction was meant to kill, now one level up and invisible at the call
site.

**Always**: when you move a validation whose result a later line consumes, keep
the invariant guard beside the helper that owns it and make it loud:

```ts
export function resolvedInitialPaid(paid: InitialPaidResolution): number | undefined {
  if (!paid.ok) throw new Error("firstCommitError did not refuse an invalid initial payment");
  return paid.paid;
}
```

A `?? fallback` or ternary here is a silent wrong-money path, not a type
workaround.

Two smaller lessons from the same review:

- A shared helper's docstring must name the readers it *covers*. "One normalizer
  so a reader cannot accept digits another rejects" was false: `parseWholeAmount`
  (supplier-return quantities) stayed ASCII-only. The claim invited the next
  agent to assume repo-wide consistency. Scope the claim, pin the scope with a
  test, and file the remaining gap.
- `limits`-style comments are not tests. The order had three comment blocks
  pinned by tests, yet the round-2 masking bug still shipped twice. Only the
  single-home helper plus a stage-by-stage ordering test makes a future reorder
  fail loudly in one screen AND the other.
