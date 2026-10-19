# Debate lens — #295 (client freshness)

- **Base:** `bff7a1a` · **Head reviewed:** `f4856e0` (fixes landed in `6f39a41`)
- **Tier:** Standard
- **Lens:** adversarial — a critic and a defender, run as two sub-agents on
  `zen-proxy/glm-5.3-flash-free` (never the author's model), then a parent
  synthesis.

## The critic's findings, and what happened to each

| # | Severity | Finding | Verdict |
|---|---|---|---|
| 1 | 9 (Blocker) | The guard compared the request against only the **newest** movement of the item. A sale, a correction or any other movement recorded in between replaced the remembered row, the signatures differed, and the same adjustment was applied twice — for one intention. The repo already solves this for supplier adjustments with a signature compared across **all** matching rows. | **Fixed** in `6f39a41`: the store reads every movement recorded inside the window (`listStockMovementsSince`) and the guard compares against all of them. Two new router tests pin it. |
| 2 | 7 (Major) | The refusal was not actionable, and it was sticky: after a refusal the last movement was still the refused adjustment, so an immediate retry was refused again. | **Fixed**: the Arabic message now says what to do — change the reason, or retry in a moment. A different reason is a different action, which is the escape hatch the predicate offers. |
| 3 | 6 (Major) | The identity carried the cost the ledger *would* hold (the request's cost, or the item's current average). The average moves with the first posting, so a retry computed a different cost and slipped past. | **Fixed** in `6f39a41`: the identity carries the cost the request *expressed*; a derived cost is not part of what the request said. A new router test pins it. |
| 4 | 6 (Major) | The pending-returns count polled without `refetchIntervalInBackground`, so the shell badge went stale in a background window — the exact case the ticket is about. | **Fixed**: the shared count now carries the background flag. |
| 5 | 6 (Major) | The e2e counted the `focus` event, but TanStack v5's focus manager listens to `visibilitychange`; and the visibility was only logged, never asserted. | **Fixed**: the spec counts visibility-changes that made the reader **visible** and asserts it is zero. The elapsed time stays a measurement, not a proof. |
| 6 | 5 (Major) | The store read "saves the whole ledger" was inaccurate — the posting seam reads the ledger anyway, so the guard's read is an extra query, not a replacement. | **Fixed in the doc**: the read is described as what it is — the rows inside the window, applied in sql. |
| 7 | 5 (Major) | The stock screen (an item's history, the running stock column) was not a hot counter. | **Fixed**: the history query rides the tick. |
| 8 | 4 (Minor) | The documented stamp format was wrong (`"YYYY-MM-DD HH:mm:ss"` vs the server's `"YYYY-MM-DDTHH:mm:ss"`), and the unit fixtures used the wrong form, so the pure half never exercised the production format. | **Fixed**: the format is the production one everywhere, and the cutoff test pins it. |
| 9 | 4 (Minor) | The read-cost numbers were asserted in prose with no committed benchmark, and the "shop of 20 items" / "50 rows" wording contradicted itself. | **Fixed in the doc**: one measurement, stated as one measurement, with the round trip named as not included. |
| 10 | 4 (Minor) | The new store read's ordering and the `seq` field meant two things across two reads. | **Fixed**: the new read has one order (insertion order) and one meaning for `seq` (the rowid), documented on the port. |
| 11 | 3 (Minor) | The design doc's blast-radius table named only the landing summary, while the constant also moved the pending-return count and the onboarding checklist. | **Fixed in the doc**: all three are named. |
| 12 | 3 (Minor) | The web test named "keeps polling while the window is in the background" asserted options, not behaviour (happy-dom has no hidden tab). | **Fixed**: renamed to what it does — "carries the background polling flag on the query" — with a note that the behaviour is measured in the e2e. |
| 13 | 3 (Minor) | The `refreshMs` prop on the two production pages is test surface area. | **Dismissed**: the dashboard already shipped that prop before this change; the alternative (a context or an env knob) is worse. |

## The defender's case, and what it changed

- **D1 — the focus-refetch gap is real, and a bounded tick is the honest fix.** The
  `QueryClient` has no defaults, so `refetchOnWindowFocus: true` and
  `staleTime: 0` apply: a window the owner clicks into catches up on its own.
  A push channel would need a long-lived transport, a server surface and a
  second implementation for the desktop sidecar, to buy sub-second
  convergence on a loopback API over a local file. **Kept.**
- **D2 — a repeat-window guard on an append-only ledger is the smallest
  honest fix, and it needs no schema column and no contracts change.** The
  `#181`-style `idempotencyKey` on the input schema is exactly the contracts
  change criterion 4 forbids, so the `#177` signature is the only available
  shape. **Kept** (with the coverage holes of findings 1 and 3 closed).
- **D3 — the guard takes the write lock first.** It reads and then writes, so
  a deferred transaction would let a second writer's read land on a stale
  snapshot. **Kept** (`withTransactionImmediate`).
- **D4 — the identity excludes `occurredAt`.** The server stamps it, so two
  identical requests differ on it. The defender flagged the one hole in
  this: a *caller-supplied* date is part of the `#177` signature, so the
  unconditional exclusion was weaker than the rule it cites. **Fixed** in
  `6f39a41`: a caller-supplied date joins the identity, a server-stamped one
  does not.
- **D5/D6 — why five seconds, and how the tick is proven.** The server bound
  is comfortable; the binding bound is the human one. The defender found the
  same hole as the critic in the written proof (the wrong event) and said
  the elapsed time should be promoted from "also" to "the" proof — then
  conceded the phase is arbitrary, which is why the spec now proves the
  isolation instead and reports the time as a measurement.

## What the synthesis changed

1. The guard now compares against every movement inside the window, and the
   store read is a windowed read (`listStockMovementsSince`) applied in sql.
2. The identity carries what the request **expressed**: a caller-supplied
   date, an explicit cost; not a server-stamped date, not a derived cost.
3. The refusal is actionable, the pending-return count ticks in the
   background, the item history rides the tick, and the e2e asserts the
   isolation on the event TanStack actually listens to.
4. The design doc now says what is true, including where the measurement is
   a measurement.

**Red without the fix:** narrowing the guard back to "the newest movement
only" fails the two new router tests (exit 1) — the ablation was run and
recorded in the commit body.
