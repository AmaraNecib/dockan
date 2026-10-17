# #256 round 2 — self-critique (the debate step, run by the lane)

Reviewed code: **7020666** (`fix-256-round2`, base `feat-256-return-defaults` = `35ece25`).
Gate disclosed: this is **not** an independent `debate` sub-agent run. The lane does not
delegate (the brief forbids `subagent` and says the parent owns parallel review), and round 1
disclosed that the `subagent` launch failed three times. So the lane wrote the strongest case
against its own change, and the parent's review is the independent one.
Format follows the brief: `command` / `expect` / `observed` / `cwd` where a run is claimed.

## The strongest case against this change

**1. It puts money on an invoice the owner never opened, and the screen he is looking at does
not name it.** The default on invoice C now reduces the remaining debt of invoices A and B.
The panel shows the party's total tab (`returns-party-debt`) and a line saying the offset
spreads over the open invoices oldest-first — but it does NOT list which invoices, nor their
amounts, and it does not say `INV-0007` / `INV-0008`. The owner approves a split whose
counterparties he cannot see, and only discovers the effect by opening each invoice afterwards
(or by reading each header's `مرتجعات` credit row). Round 1's design named exactly this hazard
when it refused. If the owner's mental model of "the tab" is the *party*, this is acceptable;
if he ever reads a single invoice as an account, today's UI is one step short of honest.
*Cheapest real mitigation:* list the planned allocation in the pending-return card (data is
already in `return_debt_applications` after acceptance; before acceptance the plan is derivable
from the same read) — deliberately NOT done here because the brief scoped this round to the
policy and the pre-acceptance plan would be a second money preview to keep in sync.

**2. The default is derived on the server from *fresh* debt, but the owner approved the split
from the numbers he saw.** An untouched form sends `cashPaidOut: undefined`, so the server
re-derives from the tab at submit time. If a payment lands between the render and the submit,
the split changes silently: the panel showed 4 000/1 000 and the record stores 3 000/2 000.
Round 1 had the same property (and documented it), and the brief endorses "untouched = the
server derives from fresh debt". Still, "what you see is what settles" is only true for a
touched control here. The alternative (send the derived numbers explicitly) is worse: the
explicit path cannot express cross-invoice allocation at all, so it would settle *wrongly*
rather than *differently*.

**3. Acceptance can still leave a promise partly unapplied, and the cash is not topped up.**
`debtApplied` records what was really relieved; if the tab shrank between create and accept the
shortfall is neither debt relief nor cash. That is #68's existing behaviour, unchanged, and this
round did not add it. But the new cross-invoice allocation *increases* the number of ways the
tab can move under a pending return, so the wart now has more surface. A true fix (re-derive the
cash side at acceptance, or refuse acceptance when the tab shrank) is a #68 change, not this
one. **Disclosed as unfixed.**

**4. Own-invoice-first is a convention this round invented** (`#10` of the design doc), while
the payment panel applies oldest-first across *all* open invoices including the one in front of
you. Two different "oldest first" rules now live in the app: payments spread over every unpaid
invoice, refunds relieve the invoice the goods came from first, then the older ones. The
justification is the explicit-choice invariance, which is a real constraint from the brief — but
a reviewer can fairly call the inconsistency a bug and ask for one rule.

**5. The new table is one more thing that can drift from `remaining_amount`.** The invariant is
now enforced by (a) `returnsAccept` writing rows and a conditional UPDATE in one unit, (b) a
backfill for old rows, (c) a legacy fallback read for rows that have none. Three mechanisms for
one number is two more than round 1 had; each is tested, and the fallback is proven load-bearing
by an ablation, but the surface is larger.

## What I could not check

- **The independent review.** No `debate` sub-agent, no second author. Green tests prove the
  behaviour I encoded, not that I encoded the right behaviour.
- **A real upgraded installation.** The backfill and the version bump were exercised against
  synthetic pre-v5 shapes I constructed (`DROP TABLE` + marker delete, a v4-style row set with
  no attribution rows), not a copy of a real owner database. No production-sized data, no
  thousands of returns, no partially-migrated file produced by an actual old build.
- **Concurrent acceptance of two returns that promise the same tab.** Covered by construction
  (BEGIN IMMEDIATE + `min(stillPromised, remaining)` + per-invoice conditional updates shown in
  the ablation as load-bearing) but there is no test that runs two acceptances in parallel on
  one party; the existing tests are sequential.
- **RTL/visual honesty of the new note and the party-debt row.** Read in the e2e DOM, never
  looked at as a screen; no screenshots. The change is copy + one numeric row, so I judged a
  screenshot unnecessary — a reviewer may disagree.
- **The 95th e2e spec.** The full `bun run test:e2e` on the final tree was 94 passed / 1 failed
  (`customer-name-variants.spec.ts` timing out in `signIn`), green on a solo re-run; I did not
  re-run the whole suite a third time to see 95/95 on this exact SHA.
