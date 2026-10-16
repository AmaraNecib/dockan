# Debate — issue #217 (`vault-gate.tsx`: one failure value)

Tier: **High-assurance** (pre-boot vault gate = credential boundary; failure mode
4). Base: `e71b2b1`. Reviewed HEAD: `aef379d`.
Independent critic + defender sub-agents, fresh context, three rounds.

Production code under review (`apps/web/src/components/vault/vault-gate.tsx`) is
byte-identical to SHA `6528d3d`; the rounds after that changed only tests and the
design/verification docs. `git diff 6528d3d aef379d --stat` = tests + `.scratch/`.

## Verdict

**No blockers. No production-code fix required.** The reachable-drift check —
the brief's explicit stop condition — is negative in every round:

> All six write sites (lock timer, `fail`, `clearFieldError`, `run` reset,
> back-to-passphrase, use-recovery) now funnel through one `setFailure`. `grep
> for setError|setErrorField` is empty. No reachable drift exists; the ticket is
> correctly described as latent.

Shape vs `vault-settings.tsx`: exact match (same `{ message; field }` state,
same derived `error`/`errorField`, same functional `clearFieldError`, same JSDoc);
only the field union differs. `App.tsx`'s `useAuthError` additionally carries a
`nonce` for re-announcement — pre-existing and out of scope.

## Findings and dispositions

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| 1 | 2 | Behavioural equivalence correct; no React correctness issue (functional updater is stale-closure-safe) | No action |
| 2 | 3 | `clearFieldError` now always queues an updater (React bails via `Object.is`); "worth a comment" | **Dismiss** — byte-identical to `vault-settings.tsx` after #211 and `App.tsx` `clearField`; a local comment would break the match-exactly constraint |
| 3 | 5 | The brief's literal criterion ("new test must fail against the unfixed component") is unsatisfiable given its own latency premise | **Surfaced, not silently swapped** — design doc + test-audit state it; mutation proof substitutes; reported to the issuer |
| 4 | 5→3 | The first mutation bundle unpaired five writes at once (coarse) | **Fixed (evidence)** — ablation table in `.scratch/verification/217/mutation-proof.md`: `[A]` run+screen passes, `[B]` `fail`-only passes, `[C]` chained drift fails |
| 5 | 4 | "Minimality is pinned" overstates it: the guard is chain-level — no isolated unpaired write fails the test | **Fixed** — design doc and `mutation-proof.md` now say the guard is chain-level and the minimal failing set is `{fail, run-reset, use-recovery, back}` |
| 6 | 3 | e2e additions are a same-screen behaviour pin, not a cross-action transition as the design claimed | **Fixed** — design doc corrected |
| 7 | 3 | Branch name lacks the `fix/` prefix; mutation proof routed to `.scratch/verification/` not `.scratch/reviews/` | **Parent-owned / by design** — the lane's branch name is harness-assigned; the three required gate files are written to `.scratch/reviews/217/`; verification artifacts are supplementary |
| 8 | 2 | `failure` names two disjoint states in one module (`useVaultStatus` and `VaultGate`) | **Dismiss** — disjoint scopes; the name buys consistency with settings/`useAuthError` |
| 9 | — | Lock timer's `setFailure(null)` can wipe a newer recovery-screen failure; lock path untested | **Out of scope (deferred)** — pre-existing, paired write (not the #217 drift), and the brief forbids changing the lock timer. Proposed follow-up, not fixed |
| 10 | — | `VaultGateField` duplicated rather than shared with `VaultSettingsField`, so the pair can be re-split | **Deferred** — the brief mandates matching, not sharing; a shared `useFailure`/`no-restricted-syntax` guard is a follow-up |

## Commands

- `bun run typecheck` → exit 0; `bun run lint` → exit 0; `bun run test` → exit 0 (4/4 tasks)
- `bun test src/components/vault/vault-gate.test.tsx` → 21 pass / 0 fail
- drift mutation `[C]` on the two-state component → 20 pass / 1 fail (proves discrimination; chain-level)
- `bun run test:e2e --output=.e2e-data/fix-217/test-results tests/e2e/vault.spec.ts` → 4 passed (2.4m); slot `fix-217` acquired and released
