# Code-review evidence — issue #129 (round 1 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHAs:** product code unchanged since
`0631081c1a30ac6e0df37b046f95064407985e9d`; test-only delta at
`3444d79220170a5be4d274987202158ffc1277e0`.

## Standards

Documented standards: `docs/engineering-workflow.md`,
`docs/development-workflow.md` (Definition of Done), `AGENTS.md`,
`oxlint.config.ts`.

The product hunks are the ones reviewed in the prior round and are unchanged:
the Arabic copy comes from `partyPhoneInvalid`, the server code
`INVALID_PARTY_PHONE` is stable, and no API display text leaks. The round-1
delta is `tests/e2e/phone-identity.spec.ts`:

- Writes are gated through `actAndAck`/`waitForRpc` (armed before the click)
  and `expectRpcOk`.
- Reads of identity/presence go through the ACKED `customersList` payload, not
  the DOM — the pattern the repo adopted in #189.
- Cleanup runs in `afterEach`, resets its tracked list, and verifies a fresh
  server read; no `.only`/`.skip`/`.todo` and no missing `await`.
- Comments explain the non-obvious choices (`pickerQuery` vs `pickerName`,
  raw-payload normalisation).

**No hard violations.**

## Spec

Issue #129 requirements remain met by the unchanged product code; this round
only hardens the e2e proof:

| Requirement | Verdict |
|-------------|---------|
| Reject non-numeric phone text at the boundary | Met — store + router + form + picker; e2e now reads the refusal back from the server and proves nothing was written. |
| Validate phone input as digits | Met — numeric rule (not mobile-only), documented. |
| Reject/normalise in picker and edit forms | Met — inline Arabic refusal in both. |
| Clear Arabic copy, i18n, no display text from API | Met — `partyPhoneInvalid`, `INVALID_PARTY_PHONE` alias. |
| Arabic-Indic accepted and normalised | Met — e2e asserts the canonical `+213…` from the ACKED list payload (raw store read), not the folded DOM. |
| Picker still selects the created record | Met — e2e proves `pick()` ran; a mutation that skips it fails the test. |

No Speculative Generality, Feature Envy, Shotgun Surgery, or Divergent Change in
the delta.
