# Code review (delta) — #171 review-fix round

- PR base (fixed point): `54a754b`
- Delta base: `4020982`
- Fix commit: `62a8dfb`
- Follow-up fixes: `943c9a01`
- Final evidence SHA: `22bc6208`
- Tier: High-assurance

Standards and Spec reviewers ran on the fix commit; findings are kept separate.

## Standards

**Hard violations: none.** oxlint and tsc are clean; the diff is source/test
only.

Judgement calls:

| Finding | Disposition |
|---|---|
| The relink effect is duplicated across sale, purchase and ReturnsPanel. | **Deferred** — a shared `useLinkedAmount` hook is the right cleanup and would remove three copies; it would widen this review-fix diff, so it is a follow-up. |
| The "reject invalid percentage" rule lives at four call sites. | **Accepted** — the predicate is shared (`percentageDraftInvalid`); the call sites are where each page decides its own error copy. |
| `useRef<"amount" \| "percentage" \| null>` re-declared inline. | **Deferred** — an exported `AmountPercentageSource` type is a minor tidy. |
| The relink effects write their own deps and rely on idempotence. | **Accepted** — each branch re-derives the *other* side from the unchanged source, so re-runs are no-ops; documented in the code. |
| New `paid > total` guards in sale/purchase. | **Kept** — small, uses existing i18n keys, and enforces the CONTEXT.md "no overpayment" rule before the api round-trip. Flagged as beyond the literal six findings. |

## Spec

The fix must address exactly six Greptile findings. Verified fixed:

1. ReturnsPanel relinks on value change — yes (`invoice.tsx` `cashSource` + effect).
2. Settle submit guard across loop + refresh — yes, and hardened to include the
   halted path after the delta review.
3. Invalid percentages rejected before save in sale, purchase and return — yes.
4. Purchase omits `initialPaid` when 0 — yes.
5. Sale recomputes a percentage payment to 0 when the total falls to 0 — yes
   (purchase received the same rule for consistency).
6. Purchase tests added — yes (six tests).

Not asked for (scope): the `paid > total` guards; the purchase `total === 0`
percentage rule. Both are small, consistent with sale, and documented.

Nothing partially fixed; no fix is wrong.

## Guard 1 + 2 (final SHA)

- `bun run typecheck` — exit 0
- `bun run lint` — exit 0
- `bun run test` — exit 0 (715 pass / 0 fail)
- `bunx playwright test` — exit 0 (49 passed / 0 failed)
- Working tree clean; evidence at `22bc6208`, diff to HEAD is `.scratch/` only.

Greptile CLI was not run in this lane (needs auth); the parent runs it on
landing.

## Verdict

Standards: no hard violations; one deferred cleanup (shared hook). Spec: all six
findings fixed with tests, no partial fixes. No unresolved blocker.
