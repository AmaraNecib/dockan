# #198, one commit order for the invoice-draft screens (follow-up to #146 / #188)

- **Tier:** High-assurance — the checkout path computes money.
- **Base:** `origin/develop` @ `21dbc13f13d1889646f4466e610decf5a077253b`
  (= branch HEAD).
- **Source:** GitHub issue #198 (follow-up to #146 / PR #188).
- **Constraint from the brief:** behaviour-preserving de-duplication plus test
  gaps. No server/contract/schema change. The visible copy of each check stays
  exactly as it is per screen.

## 1. Problem, restated precisely

Both `submit()` bodies depend on one check order:

> empty cart → party → per-line (override > quantity) → discount → payment

It is currently encoded as two near-verbatim `ORDER:` comment blocks (one in
`sale.tsx`, one in `purchase.tsx`) sitting above two hand-rolled sequences of
`if`/`setError`/`return`. PR #188 proved the cost: the same masking bug — a
payment validated against a total the line check had not yet refused — was
found in purchase **first** and in sale **second**, because the rule lived in
two places. Round 2 then found the sale discount was a third input to the total
with the same failure mode.

The rule is a domain invariant, not two local conventions. It needs one home.

## 2. Why the order is what it is (the invariant to preserve)

Every later check is derived from an earlier input:

- `total` is derived from the lines (`draftSubtotal`) and, on sale, from the
  discount (`discountAmountFor`);
- the initial-payment resolution (`resolveInitialPaid`) compares the payment
  draft against `total`.

So a cleared quantity, or an over-100% discount, drops `total` to zero (or an
invalid negative override drives it below zero), and a payment typed against
the old total then fails the amount-vs-total check. If the payment ran first it
would show «invalid payment» for a cart whose real problem is the line or the
discount. The order is: **validate raw drafts before the values derived from
them.** That is why override/quantity and the discount come before the payment,
and why the per-line override is checked before the same line's quantity (an
empty override value with a chosen type is rejected even though the quantity
may also be bad).

## 3. The seam

### 3.1 `apps/web/src/lib/invoice-draft.ts` — `firstCommitError`

```ts
/** A per-line predicate plus the message it surfaces when it fails. */
export interface LineCheck<T> {
  invalid: (line: T) => boolean;
  message: string;
}

/** The inputs one invoice screen hands to the commit-order helper. */
export interface CommitChecks<T extends DraftLine> {
  lines: readonly T[];
  linesEmpty: string;                       // the empty-cart message
  partyNeedsChoice: boolean;                // an exact typed name must be picked
  partyNeedsChoiceMessage: string;
  override?: LineCheck<T>;                  // sale's price override; before quantity
  quantity: LineCheck<T>;
  discount?: { invalid: boolean; message: string }; // sale's invoice discount
  payment: { invalid: boolean; message: string };
}

/**
 * The commit order, once: empty cart → party → per-line (override before
 * quantity) → discount → payment. Returns the message for the first failing
 * check, or null when the draft is commit-ready.
 */
export function firstCommitError<T extends DraftLine>(checks: CommitChecks<T>): string | null
```

The helper owns the **sequence** and the **line loop position**; the screens
own their copy and their predicates. `lineError`'s existing "first offender in
draft order" rule is reused (`firstLineError`), so a multi-line cart still
surfaces the same message it did.

Why a fixed-shape input rather than a list of gates: a list would put the order
back at the call sites, where a reorder in one screen would not touch the other —
the exact failure #198 exists to prevent. A fixed shape means both screens
describe the same five slots and the helper decides which one wins.

### 3.2 The pages

`sale.tsx` / `purchase.tsx` compute their own predicates (`paid` from
`resolveInitialPaid`, sale's `discountInvalid`) and pass them with their own
`t(...)` messages to `firstCommitError`. The `ORDER:` comment blocks collapse to
one pointer at the helper. Purchase passes no `override` and no `discount`.

Behaviour is unchanged: same first error, same message, same payload. The one
mechanical difference is that `resolveInitialPaid` / the discount predicate are
computed eagerly (pure, side-effect-free) rather than after the earlier early
returns.

## 4. Decision on issue point 3 — Arabic-Indic quantity digits

**Decision: yes, quantities accept Arabic-Indic and Extended Arabic-Indic
digits, deliberately and with tests.**

- The app is Arabic-first and its keyboard may produce `٥` rather than `5`. The
  money fields already accept those digits (`parseGroupedAmount`).
- Today `٥` resolves to `0`, so the line silently bills nothing and the save is
  refused with «invalid quantity» for a value that looks valid to the owner —
  the mismatch the issue flags.
- The fix shares one exported `normalizeArabicIndicDigits` between
  `parseGroupedAmount` and `parseQuantityDraft`, so the two readers cannot drift
  again.

**What deliberately does NOT change.** Quantities stay digits-only (no grouping
separators); `parseWholePercentage` stays ASCII-only, so the initial-payment
percentage path and every `resolveInitialPaid` number are byte-identical. Money
math (formulas, rounding, caps) is unchanged.

**The one intended input delta, pinned:** a draft that used to resolve to `0`
and be refused (`٥`) now resolves to `5` and is charged. This is the same kind
of single, deliberate reachable-value change as #146's cap clamp; the brief's
point 3 authorises it, and a lib test pins both the new resolution and its
subtotal.

## 5. Test gaps closed (issue point 2)

**Lib (`invoice-draft.test.ts`), new:**
- `firstCommitError` ordering table: all-invalid returns the first stage's
  message, then each stage is made valid in turn and the next one surfaces;
  the per-line override-before-quantity precedence; multi-line first-offender.
- `parseQuantityDraft` Arabic-Indic table (Arabic-Indic, Extended Arabic-Indic,
  over-cap, mixed-digit rejection) plus a subtotal pin.

**Page (`sale.test.tsx`), new:**
- **override-vs-payment**: a typed payment that survives an invalid (negative
  amount) override whose negative unit price drives the total below zero. The
  override message must surface, not `saleInvalidPaid`; nothing is sent. This is
  the sale path the round-2 fix repaired but no page test pinned.
- **quantity boundary**: `1000000` saves and the payload carries `1000000`;
  `1000001` is refused with nothing sent.
- **multi-line**: two lines, the first with an empty override value and the
  second with a cleared quantity → the first line's override message; then make
  the first valid → the second line's quantity message.

**Page (`purchase.test.tsx`), new:** a multi-line first-offender case and the
same quantity boundary, so both screens pin the shared order from their side.

**E2E:** `tests/e2e/sale-checkout.spec.ts` gains a browser-level ordering
assertion (invalid override + typed payment) and `purchase-intake.spec.ts` keeps
its drift proof; both are run in full under Guard 1 and 2.

## 6. Dependencies

`@/lib/amount-parse` (`normalizeArabicIndicDigits`, `parseGroupedAmount`,
`parseWholePercentage`, `percentageDraftInvalid`, `amountFromPercentage`,
`percentageFromAmount`). No new dependency, no server, contract or schema change.

## 7. Money math pins (must not move)

| case | pinned value |
|---|---|
| sale: 3 × 900 (amount override) − amount discount 100 | subtotal 2700, total 2600 |
| sale: 1 × 500 at 80% override − 10% discount | subtotal 400, total 360 |
| sale: percentage discount on subtotal 333 | discount 33, total 300 |
| sale: 100% discount | total 0, never negative |
| purchase: 2 × 1200 + 3 × 900, no discount | subtotal 5100, total 5100 |
| quantity `٥` (new) | line 5; 5 × price is the subtotal |
| quantity `1000000` | accepted; `1000001` refused (0) |
| `initialPaid` | 0 → `undefined`, partial → that number, over total refused |
| checkout payload | `quantity: parseQuantityDraft(draft)`, sale override only when a type is chosen |

## 8. Implementation risks

| risk | mitigation |
|---|---|
| The extraction quietly changes which message wins | `firstCommitError` is unit-tested stage by stage; the existing rendered masking tests (sale discount, sale quantity, purchase quantity) stay green unchanged, and the new override/multi-line tests falsify a reordered helper |
| Eager `resolveInitialPaid` changes behaviour | the function is pure and total; it was only *moved* earlier in `submit`, not altered |
| The Arabic-Indic widening touches money | formulas untouched; only the digit class widens; the percentage reader and `resolveInitialPaid` are frozen and pinned |
| A reorder in one page slips past the other | the order has one home; `firstCommitError` is the only place the sequence exists |
