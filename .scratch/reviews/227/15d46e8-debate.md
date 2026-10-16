# #227 round 2 — Debate evidence (critic + defender)

- Tier: **High-assurance** (unchanged). The reader under fix is the stock-movement
  delta (`stock.tsx` → `stockAddManual`), so a wrong read can drive stock below
  zero or record a removal the owner did not type — failure mode (1).
- Base for the round's delta: PR #239 head `baa4cfa` (code head `e472d5b`); the
  PR's merge-base with `origin/develop` is `6708324`.
- Reviewed HEAD: `15d46e8` (final round-2 code; the branch also carries the first
  round-2 commit `a7922f8`, whose findings were actioned here).
- Method: opposing `reviewer` sub-agents (harsh critic, charitable defender) on a
  read-only checkout, with a live reader probe and an independent reorder
  mutation by the parent. Reviewers had no shell; every load-bearing claim below
  was reproduced by the parent (`bun -e`, `bun test`).

## Why the debate gate ran

High-assurance per `docs/engineering-workflow.md` (Review tiers): the diff sits on
the stock-quantity path, so it can violate failure mode (1) «stock quantity goes
below zero». Round 1 reached the same tier.

## The bug and the fix

`parseSignedWholeNumber` stripped the `-` before normalising, so in `"-\u200f5"`
the interior mark became leading by the time `stripEdgeBidiMarks` ran and was
stripped: the stock form accepted `-5`, bypassing the interior-mark refusal.
Pre-fix behaviour: `parseSignedWholeNumber("-\u200f5")` returned **`-5`** (must be
`null`).

The fix normalises the whole signed draft and judges it sign-aware with
`/^-\s*\d+$/u` **before** slicing the sign, then reads the magnitude through the
private non-normalising `readNormalizedDigits`. `parseWholeNumber` now delegates
to the same helper so the two readers in the file cannot drift.

## Review round history

- **Round A (`a7922f8`)** — the first run of the three gates found no blockers.
  Actioned in `15d46e8`: (a) the spec axis noted the comment claimed the draft
  was judged before the sign left while the code judged after slicing — fixed by
  the sign-aware gate; (b) `"- 5"` was unpinned — now pinned; (c) the
  edge/override/boundary controls were missing — added.
- **Round B (`15d46e8`)** — this evidence file.

## Critic findings and dispositions (round B)

No blocker. Severity 1–10 (10 = must-fix blocker); all ≤ 4.

| Finding | Sev | Disposition |
|---|---|---|
| A mark *in front of* the sign (`"\u200f-5"`) is still refused while `"\u200f5"` reads — a reachable paste asymmetry | 4 | **Deferred, disclosed.** Safe refusal (never a wrong value); accepting it is a separate behaviour change that needs its own RTL display-order proof. Named in the design's «Deliberately out of scope» and in the lane report. |
| `parseGroupedAmount` normalises a second time after `STRIP_GROUPING` | 3 | **Not this round's code; safe.** Its grouping regex rejects any draft containing a mark before the replace runs, so the mark can never be re-parented. Documented in the class-sweep cell; widening those regexes is the trigger to revisit. Candidate follow-up, not fixed quietly. |
| The sign-aware gate is behaviourally redundant with `slice(1).trim()` + `readNormalizedDigits`; the `\s*` attribution in the comment is loose | 2 | **Kept deliberately.** The brief's instruction is to *validate the whole normalised signed draft before splitting*; the gate is that validation made explicit even though the magnitude read alone also refuses the interior case. Belt-and-suspenders, harmless. The comment is being left as-is this round rather than invalidating the reviewed SHA for prose; noted. |
| Combined-edge coverage uses RLM only between sign and digits | 3 | **Accepted.** `stripEdgeBidiMarks` is position-based and script-agnostic; the ten marks are covered at the edge by the round-1 loop. The sign-position case is representative. Candidate follow-up if cheap. |
| `/^\d+$/` (no `u`) in `readNormalizedDigits` vs `/u` in the gate | 1 | **Dismissed, cosmetic.** Identical for ASCII digits; the flag drift predates the round. |
| `-0` returns `-0` | 2 | **Deferred.** Pre-existing; the stock form refuses it via `parsedDelta === 0`. Named as a candidate follow-up. |
| `\s*` admits U+FEFF/U+200A etc. between sign and digits | (edge hunter) 2 | **Pre-existing, not a regression.** `String.trim()` already removed the same code points pre-#227, so the read is byte-identical to the old path; a `\s`-narrowing would *tighten* an ASCII/whitespace input. Left, pinned for `"- 5"`. |
| Class closure for sign/separator removal | — | **Confirmed closed.** Independent grep: the only pre-normalisation *content*-removal sites are `numeric-input.ts` sign handling; `.trim()` removes only whitespace, which cannot re-parent a mark. |

## Defender's position

The defender rated the core defences 9–10/10: the normalise-then-judge-then-slice
ordering (10, hand-traced); `readNormalizedDigits` is a read not a normaliser (10);
the reader inventory is complete (8, grep-verified); the preserved leading-mark
refusal is a safe refusal, not a wrong value (9); the reorder pin genuinely fails
on the old order (9); ASCII is untouched (9). Its residual risk — the reorder
mutation was reasoned, not executed by the defender — was closed by the parent's
executed mutation below.

## Decisive evidence

- **Executed mutation (parent, at `15d46e8`):** re-created the round-1 order
  (`parseWholeNumber(trimmed.slice(1))`), re-ran `bun test
  apps/web/src/lib/numeric-input.test.ts` → the ordering pin fails
  (`expect(...).toBeNull()` received `-5`) with **12 pass / 1 fail**; reverted,
  suite green (13 pass). Raw probe on the mutant:
  `parseSignedWholeNumber("-\u200f5")` = `-5`.
- **Live reader probe (parent):** at `15d46e8`, `"-\u200f5"` → `null`,
  `"-\u200f٥"` → `null`, `"-5"` → `-5`, `"-\u200f5\u200f"` → `null`,
  `"-5\u200f"` → `-5`, `"- 5"` → -5, `"-"` → `null`, `"\u200f5"` → 5,
  `"\u202e-5"`/`"-\u202e5"` → `null`, `"-9007199254740993"` → `null`.
- **Gates at `15d46e8`:** `bun run typecheck` exit 0; `bun run lint` exit 0;
  `bun run test` exit 0 (web 1135 pass / 0 fail; api 934; desktop 68;
  e2e-support 22; scripts 73 pass / 1 skip); `bun run test:e2e
  tests/e2e/sale-checkout.spec.ts` exit 0, 5 passed (ports 4441/5291).
