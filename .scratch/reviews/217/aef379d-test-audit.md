# Test audit — issue #217

Tier: **High-assurance**. Base: `e71b2b1`. Reviewed HEAD: `aef379d`.
Three independent sub-agents (edge-case hunter, coverage analyst, quality
reviewer), fresh context. Two rounds: round 1 at `63cd623`, round 2 verifying
the fixes at `aef379d`.

## Round 1 findings and dispositions (at `63cd623`)

| Finding | Decision |
|---------|----------|
| The brief's literal "fail against the unfixed component" is unsatisfiable for a black-box DOM test (latent bug) | **Surfaced + substituted** — mutation proof in `.scratch/verification/217/mutation-proof.md`; design doc states it |
| Test 1's back-nav assertion relied on the back handler's own clear; its comment over-claimed | **Fixed** — comment now states the guard is chain-level |
| `expectNoFieldBlamed` skips unmounted inputs, so its doc claim was false at the recovery-screen call site | **Fixed** — doc states the mounted-only limit and points at the wrong-passphrase test for the mounted previously-blamed field |
| Coverage: recovery/per-field edit-clear, cross-field guard, unlock-screen field-less aria absent | **Fixed** — three tests + assertions added |
| a11y: no test that a field-less failure focuses the alert | **Fixed** — `document.activeElement` assertion added; the round-2 hunter confirmed it detects a `focus={false}` mutation and that the field-blamed tests detect `focus={true}` |
| Setup duplication between tests 1 and 2 | **Deferred** — the two flows diverge (empty-passphrase pre-leg vs empty-recovery pre-blame); a helper fitting both takes a callback and reads worse. Judged not worth the ceremony |
| Lock-timer path untested; the timer can wipe a newer cross-screen failure | **Deferred (out of scope)** — pre-existing, a *paired* write (not the #217 drift), and the brief forbids changing the lock timer. Proposed follow-up |
| `run` reset / functional-updater form not independently pinned | **Documented** — the ablation table shows no isolated unpaired write is caught; the guard is chain-level by nature of the latency |

## Round 2 (at `aef379d`)

**Quality reviewer: A− (A).** "Flag (a) — back-nav over-claim: fixed. Flag (c) —
helper doc: fixed. New focus assertion: correct, not tautological." Remaining:
setup duplication (flag b), and a loose closing clause in the comment.

**Edge-case hunter:** "Focus assertion is a real detector … the round-2 addition
closes the a11y half of #217. Doc/comment corrections are accurate." Remaining
gaps: the forward-navigation clear has no direct assertion (MEDIUM); a distinguishing
test for `run`'s reset (MEDIUM); `expectNoFieldBlamed` can pass with zero inputs
checked if a testid is renamed (LOW); lock timer (LOW/out of scope).

**Coverage analyst:** "Brief's cross-action criterion is met … Diversity is good …
`mutation-proof.md` is sound and honest … the right way to handle an unsatisfiable
criterion." Gaps: lock timer, `run` reset.

## Synthesis — actions

Fixed this round: chain-level comment, helper doc, focus assertion, design-doc
mutation section and e2e claim.
Deferred with reasons (none is a production defect):

- **Lock timer** — out of scope by brief; pre-existing; follow-up issue.
- **Forward-nav clear assertion** — the use-recovery and back handlers are the
  same `setFailure(null)`; the back leg already pins that path without it.
- **`run`-reset / functional-updater unit probes** — the mutation proof already
  documents that these are not unit-detectors; adding probes would assert
  behaviour identical in both shapes.
- **Setup duplication / helper "≥1 input" guard** — refactor ceremony with no
  discriminating value; the helper's `id` pin fails if the alert is absent.

## Commands

- `cd apps/web && bun test src/components/vault/vault-gate.test.tsx` → 21 pass / 0 fail
- ablation `[A]`/`[B]` pass, `[C]` fails (mutation proof)
