# Code review — #193 + #202 at `30a0359`

**Method:** `code-review` skill — Standards and Spec axes run as independent
read-only sub-agents against `git diff f757211...HEAD`. Three rounds were run as
the diff changed (findings fixed in `c8ee009`, `9309830`, `30a0359`). This file
records the final round; the earlier rounds' findings and their disposition are
below.

## Round 3 (final) — Standards axis

> **Correct — native-value extraction.** `setNativeValue` is a function; the only
> `HTMLInputElement.prototype` read happens on call, inside `act`, so no
> module-load deref remains. Both `setInput` and `fillAmounts` route through it —
> DRY, no duplicated setter lookup. The `setter === undefined` guard replaces the
> old silent `?.call` no-op (a missing setter now fails loudly instead of leaving
> rows empty).
>
> **Correct — `vaultPort`.** Blank/undefined → fallback; non-integer, `<1`,
> `>65535` → named throw. Resolved once at module scope, so spawn env,
> health/status polls and navigations cannot diverge. Defaults 4399/5174 keep
> existing runs byte-identical.
>
> **Correct — superseded notes.** Both stale vault-port wisdom files now point at
> the replacement vars while preserving the failure signature.
>
> **Note — doc/code drift.** The wisdom snippet still showed `key!` and
> `setter?.call`. *Fixed in `30a0359`.*
>
> **Note — Inappropriate Intimacy.** `fillAmounts` reaches into React's private
> `__reactProps$` bag via a widening cast. Documented (SAFETY comment, DOM-event
> fallback) and bounded to one test helper — the accepted risk in the design doc.
>
> No blockers.

## Round 3 (final) — Spec axis

> **Correct (verified at `9309830`).**
> - Defaults intact: `vaultPort("DOKAN_VAULT_PORT", 4399)` /
>   `("DOKAN_VAULT_WEB_PORT", 5174)` — matches "defaults 4399/5174".
> - "setup/health-check paths use the resolved ports": spawn env, web spawn,
>   both `waitForOk` polls, the vault-status poll and all four
>   `page.goto(:${WEB_PORT})` read the resolved constants only; no literal
>   4399/5174 remains outside the fallbacks.
> - Validation is sound: blank → fallback; `Number.isInteger` + 1..65535 so
>   port 0/NaN/typos throw instead of silently spawning a dead pair.
> - #193 fix is a genuine cost reduction, not a bound bump: `fillAmounts` batches
>   200 state updates into one `act` render, applied to both cap tests. Invoking
>   `props.onChange({target})` is compatible — the page handler reads only
>   `event.target.value`; a DOM-event fallback preserves correctness on a React
>   rename.
> - AGENTS.md handling of unmerged #199 confirmed accurate: the note mirrors the
>   real constraint text on the #199 branch, scopes the relaxation to exactly
>   that constraint, and says not to reintroduce it on rebase.
>
> **Note.** The 200-row contract-limit test previously used Bun's default bound;
> it now carries the named `60_000`. That is an added bound, so it brushes the
> "no timeout increase as the answer to a flake" rule — defensible only because
> the answer is the render-cost fix and the bound is documented as a >20× safety
> net. Kept as a note, not a blocker.
>
> **Note.** `vaultPort` validation has no focused unit test; exercised only
> implicitly by the e2e run (deferred, see report).
>
> No missing/partial requirement, no scope creep beyond scratch/docs, nothing
> implemented-but-wrong found. No blockers.

## Round 1 / 2 findings and disposition

| Finding (axis) | Disposition |
| --- | --- |
| Sibling 200-row test had the same discrete-event fill (coverage) | **Fixed** — routed through `fillAmounts` (`c8ee009`); it ran ~48 s, now ~0.6-1.8 s |
| Duplicated native-value-setter extraction (Standards) | **Fixed** — shared `setNativeValue` |
| `Number(env ?? default)` yields `0`/`NaN` for blank/typo (Standards, Spec, Quality) | **Fixed** — `vaultPort` blank=unset + 1..65535 validation (`9309830`) |
| Sibling wisdom files still assert hardcoded 4399/5174 (Standards, Spec) | **Fixed** — superseded notes in both |
| AGENTS.md cites unmerged PR #199 (Standards) | **Accepted** — the warning lives only on #199; the note scopes the relaxation and guards the rebase. Both axes called it correct |
| "60× headroom" claim optimistic (Quality) | **Fixed** — reworded to measured ~1-2 s / >20× (`c8ee009`) |
| Wisdom snippet drifted from shipped helper (Standards) | **Fixed** (`30a0359`) |
| No committed concurrency/contention test (Coverage) | **Deferred** — see report; proofs are recorded here |

**Verdict:** both axes, no blockers.
