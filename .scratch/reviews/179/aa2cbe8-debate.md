# #179 — Debate evidence (critic + defender)

- **Reviewed HEAD:** `aa2cbe8d553267025d986e749805a1a3c8d4cafc`
- **Base:** `8bf2a817a2d25a58653704f1c4c15542bd822cc2` (`origin/develop`)
- **Tier:** Standard (test-only). Debate run at the brief's explicit request.
- **Method:** two parallel read-only reviewer sub-agents (HARSH CRITIC,
  CHARITABLE DEFENDER). A first round ran against `d226fb9`; its findings were
  fixed (read acks, commit `2faa306`) and a confirmation round ran against
  `aa2cbe8`. Both rounds are reflected below.

## Round 1 (`d226fb9`) → fixes applied in `2faa306` / `aa2cbe8`

| # | Finding | Sev | Decision |
|---|---|---|---|
| F1 | `actAndAck` left the armed `waitForResponse` unawaited when the action itself threw, surfacing teardown as an unhandled rejection over the real error. | 4 | **Fixed** — `catch` swallows the armed wait and rethrows the action error. |
| F2 | Residual 5 s *read* poll: after the write acks, the search render was still asserted inside the default window, so a slow `catalogSearch` under load could still flake. | 4 | **Fixed** — every catalog fill now awaits the `catalogSearch` response (`searchFor`). |
| F3 | Six repeats of the `actAndAck("catalogSearch", () => search.fill(q))` shape (Duplicated Code smell). | 3 | **Fixed** — local `searchFor` helper. |
| F4 | Stale `SAFETY:` comment sat on `const number = saved.invoiceNumber` after the DOM scrape was removed. | 2 | **Fixed** — reworded to state the contract shape and the card assertion. |
| F5 | `waitForRpc` matches any POST to the path, so a concurrent/retry `catalogSearch` could satisfy the wait. | 3 | **Dismissed** — the fills are sequential and all writes are acked first, so no second request overlaps; the ack is a bound, and the following row assertion remains the truth signal (a wrong/stale response cannot make a bad render pass). Noted as residual. |
| F6 | Cross-spec truncation at `DEFAULT_CATALOG_LIMIT = 20` is not fully removed. | 3 | **Accepted** — the spec's stamped rows are the only strict matches for its fold queries, the `catalogSearch` contract exposes no category filter, and the issue forbids an app change for a test-only fix. Documented in the design risks. |
| F7 | `expectRpcOk` non-2xx branch and `rpcOutput` envelope parse are untested. | 2 | **Deferred** — see Deferred items. |
| F8 | `expect(resolved.ok()).toBe(true)` instead of the skill's `toBeOK()`. | 1 | **Dismissed** — the custom message names the procedure and status; a judgement call. |

## Confirmation round (`aa2cbe8`)

**Critic:** no blockers. Scores: matcher 8/10, `expectRpcOk` 8/10, `actAndAck`
7/10, `rpcOutput` 8/10, receipts 6/10 (same-class unwrapped UI polls remain on
non-reported writes: settings-save, category, quick-add, `pmt-submit`),
arabic-search 7/10, truncation 8/10, parties 8/10, scope 10/10. Verified the
changed specs pass and the repetition evidence covers helper logic and
`workers=2` contention; could not cover CI-scale 2-core I/O.

**Defender:** every claimed decision holds with file:line evidence. Strongest
counter-arguments:
- *"Just a longer wait"* — **defense holds**: the ack is event-driven on the
  real response, validates status, and reads the server-issued number; no timeout
  value was raised. Two controlled 10 s-delay experiments show the base specs
  fail with the exact reported symptoms while the new specs pass.
- *"Limit-20 truncation"* — **defense holds**: scoping removes cross-spec
  satisfaction; for «الب» the fuzzy score of `batteryItem` is 0, so truncation
  cannot manufacture the freshness assertion.
- *"No app-race proof"* — **holds enough**: no app change is justified; the
  absence of an app race is inferred from the CI log, the experiment, and the
  correct render semantics. Residual: the claim "every write is acked" is
  narrower than the word *every* — four non-reported polls remain.

## Verdict

No must-fix blocker. The one literal acceptance gap (full-suite `--workers=2`
green) is a documented, unsupported parallel mode: two pre-existing first-run
setup races (`00-onboarding.spec.ts:104`, `vault.spec.ts:166`) that the shipped
`workers: 1` config and the issue's scope guard both exclude. The affected specs
are green at `--workers=2`.
