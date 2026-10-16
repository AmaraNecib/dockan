# #227 round 2 — Code-review evidence (Standards + Spec)

- Tier: **High-assurance** (stock-movement delta; failure mode (1)).
- Base for the round's delta: PR #239 head `baa4cfa` (code head `e472d5b`); the
  PR's merge-base with `origin/develop` is `6708324`.
- Reviewed HEAD: `15d46e8` (final round-2 code; first round-2 commit `a7922f8`).
- Method: two independent axes as separate `reviewer` sub-agents on a read-only
  checkout. Reviewers had no shell; the parent reproduced the load-bearing claims
  (`bun -e`, `bun test`, mutation). Per `docs/engineering-workflow.md` the axes
  are reported separately and not reranked.

## Standards axis

No hard violation of `AGENTS.md`, `docs/engineering-workflow.md`,
`.agents/wisdom/2026-10-15-extraction-ordering-guard.md` or
`.agents/wisdom/2026-10-15-extraction-must-not-tighten-money-readers.md`.

- **Ordering-guard wisdom applied.** The invariant lives beside its caller:
  `readNormalizedDigits` documents exactly which reader passes what, and the
  sign-aware gate runs before the sign leaves. The banned shape (a `?? fallback`
  or ternary returning a *value*) is absent — the signed reader returns `null`,
  a refusal, not a silent wrong number.
- **Extraction-must-not-tighten applied.** `parseWholeNumber` is
  behaviour-preserving (`readNormalizedDigits(normalizeArabicIndicDigits(text)
  .trim())` substitutes the removed body line-for-line). The one tightened path —
  `parseSignedWholeNumber` refusing `"-\u200f5"` — is the finding's own change,
  carries its own test and its own review round, which is the lesson's escape
  clause.
- **Judgement calls, all dispositioned:**
  - *Duplicated Code (low):* `readNormalizedDigits` and `parseWholeAmount` /
    `parseWholePercentage` inline the same strict read. Deliberately scoped out
    in the design; one shared **normaliser** is the constraint, which holds. A
    repo-wide strict-read dedup is a candidate follow-up.
  - *Repeated switch (minor):* the gate `^-\s*\d+$` restates the digits-only test
    in `readNormalizedDigits`. Intended — it must judge while `-` is attached.
  - `magnitude === null ? null : -magnitude` is now reachable only via the
    safe-integer bound; a reader could mistake it for redundant. Harmless.
- **No scope creep, no regressions.** The delta touches one source file, its test
  and the design doc; the strip is not widened.

## Spec axis (brief + Greptile finding + `227-design.md` Round 2)

**In-scope requirements: complete.**

- *Validate the whole normalised signed draft before splitting off the sign.*
  `parseSignedWholeNumber` normalises `trimmed`, gates with `/^-\s*\d+$/u`, and
  only then slices. The magnitude is read by a helper that never re-normalises.
- *A regression test for the ordering, not just the value.* The pin proves the
  mark is interior to the signed draft and requires `null`; reordering the two
  steps yields `-5` and fails it (executed mutation, in the test-audit evidence).
- *Cover the class, not the instance.* The design's class-sweep table enumerates
  every reader that trims/splits/removes before normalising; exactly
  `parseSignedWholeNumber` is affected. The rest are argued: `.trim()` removes
  only whitespace (non-content) and so cannot re-parent a mark;
  `parseGroupedAmount`'s separator strip runs after a regex that already rejects
  marks; `parseLooseNumber`/`nextUnitCost` have no split. The consumer is named
  (`stock.tsx:44,95`).
- *Constraints 1–5 survive:* interior marks refused; LRO/RLO refused edge and
  interior; edge marks stripped (`"\u200f٥"` → 5, `-5\u200f` → -5); ASCII
  identity; one shared normaliser.
- *Verification stated:* pre-fix behaviour (`-5`) and the mutation are recorded.

**Implemented-but-wrong:** none found.

**Unchanged on purpose / deferred (not silent):**

- `"\u200f-5"` (edge mark before a sign) stays a refusal — documented in the
  design; a separate behaviour change with its own RTL display-order proof.
- `-0` reads as `-0`; normalising it is a separate reader change with no
  owner-visible effect today.
- A repo-wide strict-read dedup and a stock consumer/e2e pin are named as
  candidate follow-ups in the lane report.

## Round history

The first code-review round at `a7922f8` flagged: (a) the comment claimed the
draft was judged before the sign left while the judgement ran after slicing —
fixed by the sign-aware gate; (b) the `readNormalizedDigits` docstring was
imprecise — fixed; (c) the design's "exactly one strict-read implementation" was
over-claimed — scoped to `numeric-input.ts`. All are in `15d46e8`.

## Commands at `15d46e8`

`bun run typecheck` exit 0; `bun run lint` exit 0; `bun run test` exit 0 (web
1135 pass / 0 fail); `bun run test:e2e tests/e2e/sale-checkout.spec.ts` exit 0,
5 passed. Full breakdown in `15d46e8-test-audit.md`.
