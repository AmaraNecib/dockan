# Linked amount/percentage inputs and oldest-first settlement (#162/#164)

**Date:** 2026-10-12 · Area: apps/web/src/components/ui/amount-percentage-input.tsx,
apps/web/src/components/parties/{party-settle,customer-settle-panel}.ts(x),
apps/web/src/pages/{sale,purchase,invoice,party-detail}.tsx

## The linked field must name its source, not infer it (🔴 Major)

A controlled amount⇄percentage pair cannot infer "which field was edited" by
diffing the next value against the current one: editing the percentage almost
always changes the amount too, so the diff misclassifies the source. The
component must hand the parent the edited field explicitly
(`onChange(next, "amount" | "percentage")`). The parent keeps it in a ref and,
when the reference total later changes, re-derives the OTHER side from the
edited one. Without this, a "50%" payment silently keeps the old amount while
the label shows 50% of the new total.

## A draft typed before the reference exists must survive (🔴 Major)

A `useEffect` that seeds the pair from `total` runs on every render while
`total === 0`. If its empty-cart branch also clears the value and resets the
source, it wipes a payment typed before the first line was added — the sale then
saves the full total instead of the typed amount (caught by `receipts.spec.ts`).
Only reset when the pair is untouched; an edited draft is the owner's.

## "Oldest first" needs a monotonic tie-break (🔴 Major)

`createdAt` is second-precision. Two invoices created in the same second have
identical timestamps, so ordering falls to the `id` — a random UUID — and the
same payment spreads to different invoices on different runs. Tie-break on the
invoice number's numeric sequence (`INV-%04d`) before the id; compare it
numerically, not lexically (`INV-0010` must sort after `INV-0009`).

## Per-invoice payment loops are not atomic (🟠 Subtle)

`invoicesPay` is atomic per invoice, but a settle loop over N invoices is not.
On a mid-loop failure, refetch every affected query and HALT the panel (disable
confirm) until it is reopened, or the next submit replans from stale rows and
re-sends money already taken. A true batch endpoint is the real fix.

## Pre-filling the full reference is a product decision, not a default (💡 Design)

Applying the component's "default = full reference" to a payment field flips the
old "blank = full credit" semantics to "full paid". It is what #162 specifies,
but it changes who is recorded as owing money; flag it explicitly rather than
letting the component's default decide silently.

## Round 2 (#171) — the Greptile findings the first review missed

**Blank is not invalid (🔴 Major).** A parser that returns `null` for both `""`
and `"abc"` conflates the legitimate "unpaid / zero cash" choice with an error.
Consumers must distinguish them explicitly (`draft.trim() !== "" && parse() ===
null`); otherwise an invalid percentage silently takes the blank path and the
invoice is saved unpaid. One shared predicate (`percentageDraftInvalid`) used by
every consumer beats four inline checks.

**A submit guard must outlive `isPending` (🔴 Major).** `mutation.isPending`
clears when the last awaited call resolves, *before* the follow-up refresh
settles. Hold a `submitting` flag across the whole body AND check it inside
`submit()` (a raw form submit bypasses a disabled button), and include the
halted/error state in that guard too — the error path's fire-and-forget refresh
would otherwise let a second raw submit replan from stale rows and re-send money.

**A percentage-based amount must follow its reference to zero (🟠 Subtle).** The
"preserve a typed draft" rule is for *amount* sources. When the reference falls
to zero (a 100% discount, all lines removed), a percentage-source draft must
recompute to 0 or the stale positive amount reaches the api and is rejected.

**Guard tests must assert the save happened (🟠 Subtle).** `expect(lastInput
?.initialPaid).toBeUndefined()` passes vacuously when a guard blocked the save
and left `lastInput` null. Assert `expect(lastInput).not.toBeNull()` first, or
the test proves nothing.

**Verify the reviewer's own fix.** A "block the disabled-button bypass" test must
dispatch a raw form `submit`, not a `click` on a disabled button, and must cover
the error/halted path — the first round only proved the success path.
