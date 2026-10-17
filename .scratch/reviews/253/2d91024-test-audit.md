# #253 — test audit (3 lenses, run against c1c9e25)

Three independent reviewer children (edge-case hunter, coverage analyst, test
quality reviewer) read the diff `git diff d843566...HEAD` and the new/changed
tests. Verdicts and dispositions below. The disposition is the follow-up commit
`2d91024`.

## Edge-case hunter

| # | Finding | Risk | Disposition |
|---|---|---|---|
| 1 | A direction token other than `WE_OWE`/`THEY_OWE` mapped silently to the WE_OWE word (a flipped debt direction, no crash) | orange | **Fixed.** The activity branch now accepts only the two enum tokens; anything else falls through to the raw row. New test `leaves an unknown direction token raw rather than inventing a direction`. |
| 2 | A known tag with too few fields leaks the raw tag (`SUPPLIER_ADJUSTMENT WE_OWE 400`) | yellow | **Accepted.** Emit sites always append the free-text field; the raw fallback is the row-keeping contract. Not guarded (unreachable today). |
| 3 | Empty / one-token summary renders blank or raw | yellow | **Accepted.** The api never writes an empty summary; rendering raw beats inventing copy. |
| 5 | `PARTY_DELETED` links to the deleted party's route (dead navigation, no crash) | orange | **Accepted.** A link that 404s is no worse than the bare id it replaced; a deleted party legitimately has no record. Not tested (the route's not-found state is out of scope). |
| 8 | `event::message` map keys the exact English sentence; a reworded api message silently reverts to raw | orange | **Fixed.** `still logs the exact startup sentences the web translates` (api side) pins the eight pairs against the api source. Ablation D proves it bites. |
| 9 | `tokens[1] ?? null` was dead (`>= 4` guarantees index 1) | cosmetic | **Fixed** by the same rewrite (the token is read directly, guarded). |

No blockers; #1 was the only wrong-answer case.

## Coverage analyst

Four requirements mapped: the opening-balance sentence (unit, both directions,
cross-screen key identity), the server-tag enumeration (web set-equality + api
emit-site scan, two independent hops), the reference link (6 unit cases + e2e
click), and the diagnostics catalogue (badge loop over all 38 `logEvents`,
message map, DOM + e2e). No duplicate coverage.

Gaps:
1. **"Port stored" and the Tukan-routed sentence have no source.** Concurred —
   neither string exists anywhere in `apps/`, `packages/` or `docs/` (case-
   insensitive grep). Four of the six owner-named strings are the boot rows and
   are translated; the other two are surfaced to the parent as a decision
   (see the crew report), not guessed at.
2. The vocabulary→emit direction is deliberately absent (PASSWORD_RESET, the
   VAULT_* tags) — documented in the test.
3. `log-copy.test.ts` asserts translated-not-equal, not a specific Arabic line —
   acceptable; the exact Arabic is not the contract, the absence of English is.

## Test quality reviewer — grade B

Correct: two-sided assertions (tag gone **and** data kept), vocabulary lockstep,
non-vacuous scans (>= 25 emit sites), async hygiene in the diagnostics mount
helper, claim-shaped `it` names.

| Note | Disposition |
|---|---|
| The withdrawal/return-debt tests passed on raw output (`not.toBe` + `toContain(name)` only) | **Fixed.** Added `not.toContain("WITHDRAWAL"/"NORMAL"/"RETURN_RECORDED")`. |
| `SETTINGS_UPDATED` had `keeps: []`, so no positive assertion on that row | **Fixed.** The loop now asserts non-empty copy; a dedicated test pins `activitySettingsUpdated`. |
| `afterEach` unmounted outside `act()` while the comment claimed that prevented warnings | **Fixed.** Unmount runs inside `await act(...)`. |
| The "stable DKN code" assertion was a passthrough of the fixture | **Accepted.** Pre-existing; the API-side property is covered where the code is derived. |
| Module-level mutable mock state | **Accepted.** Reset in `beforeEach`; isolation holds. |
| `activity-tags.test.ts` docblock claimed a reverse assertion the test does not make | **Fixed.** Docblock corrected. |
| `>= 25` emit-site floor is a magic number | **Accepted.** It is a vacuity floor, not a coverage target. |
| No unit render test for `activity-ref-link` | **Accepted.** E2E-only because an opening-balance seed would break two sibling specs' exact `/debts` totals; documented in the design doc. |
