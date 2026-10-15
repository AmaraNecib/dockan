# #206 — code review (head 502dfdd, prose delta)

Scope: `docs/ci.md` and
`.agents/wisdom/2026-10-15-vault-concurrent-runs-are-kdf-bound.md`, the only
files changed since 7caa6b6. Reviewed on the two axes this repo uses. No code or
test changed, so the 7caa6b6 code-review still covers the implementation.

## Spec — does the edit match the finding?

Finding: `docs/ci.md` overstated what the negative control proves; the wisdom
note repeated it.

- docs/ci.md now calls the control timing-dependent and says it "does not prove
  isolation"; it gives the finding's two reasons (test 1 never creates a vault;
  `waitForOk` checks only HTTP success, not server ownership) and names what
  would prove isolation (each run completing its own vault flow on disjoint
  pairs, or a server ownership check), ending "a heading is neither".
- docs/ci.md's KDF paragraph now makes the timeout attribution conditional: KDF
  contention only once isolation is proven, "on an unproven shared pair it can
  be either". That addresses "a later timeout alone does not establish CPU
  contention".
- wisdom: the "Always" rule keys isolation to each run passing test 2 and 3 on
  its own server, marks the wrong-gate failure timing-dependent rather than
  immediate, and keeps the KDF/timeout distinction conditional.
- Kept as-is: the KDF-bound signature and its measurements, and the "not in CI /
  stays manual" decision.

Disposition: spec satisfied, no gap. The overstated claims are gone from both
files (checked by diff).

## Standards

- No overclaiming remains; the uncertain parts are marked uncertain.
- `unslop`: two em dashes introduced by the first pass were removed in 502dfdd;
  the additions use periods and commas. No filler or hedging.
- Style matches the surrounding prose; no new files, links, or code.

Disposition: standards satisfied.

## Not regenerated

- Test-audit: no test changed since 7caa6b6.
- Full review subagents: not warranted for a two-file prose calibration. This
  delta plus Guard 1 and Guard 2 is the evidence.

Verdict: no actionable findings.
