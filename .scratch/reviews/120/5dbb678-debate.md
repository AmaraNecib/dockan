# Issue #120 — Debate evidence (High-assurance)

- **Reviewed HEAD:** `49de19a6a0797c9d56c2236f28314de27745a1f9` (implementation commit)
- **Fix commit / evidence HEAD:** `5dbb6788a0a44de0365c86b4fb1c774d1dec160d`
- **Base:** `8579fcf8f5d2197ec74d7fc01331530aef917957` (`origin/develop`)
- **Method:** two parallel read-only reviewer sub-agents — a harsh critic and a
  charitable defender — over `git diff 8579fcf...49de19a`, plus the issue, the
  ADR (`docs/adr/0007`), and `.scratch/implementation/120-design.md`. The parent
  synthesized, fixed the accepted findings, and recorded this file. Test quality
  is handled by the separate test-audit pass.

## Defender verdict

"Confidence in 'this is the right design and it is implemented as designed':
**9/10**; the residual risks are quality-of-life edges, not correctness holes."
It singled out as strongest: the role-parameterized store seam (one rule, one
place; closed literal table map), phone canonicalization (`null` for absent →
SQLite NULLs stay distinct; canonical `+213…`; landlines survive), the
marker-gated + self-healing backfill (idempotent even without the marker;
history never rewritten), the picker's real combobox semantics, the full-page
detail with a shared `PartyForm`, and byte-for-byte compatibility for typed-only
invoices (debts readers untouched).

The critic found **no blocker (8–10)** and no money-corruption path.

## Synthesis — critic findings and resolution

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| F1 | 6 | One static «إجمالي المشتريات» label over a role-dependent total (`partyStatsSchema.totalAmount`) | **Fixed**: split into `partyStatsTotalSales` («إجمالي المبيعات») for customers and `partyStatsTotalPurchases` for suppliers; `StatsStrip` takes the role |
| F2 | 7 | `invoicesCreate` accepted an unvalidated `counterpartyId` (nonexistent or wrong-role), creating invoices no party page can show | **Fixed**: the create transaction resolves the party through `getParty(role, id)` and refuses `PARTY_NOT_FOUND` before any write; router test covers unknown + wrong-role + the valid path |
| F3 | 5 | UI delete-disabled uses the kind-scoped count while the store counts any kind | **Resolved by F2**: a party id can now only reach its own role's invoices, so the two counts agree |
| F4 | 6 | `deleteParty` was check-then-act, safe only because the router wrapped it | **Fixed**: the rule is now one conditional `DELETE … WHERE id = ? AND NOT EXISTS (invoices …)`; the statement itself cannot delete an invoiced party |
| F5 | 5 | A legacy negative/fractional `remaining_amount` would fail `dinarsSchema` output validation and blank the whole list/detail | **Fixed**: `safePartyStats` clamps to a whole non-negative number at the store edge (dashboard degrade-one-section precedent); store test inserts a negative remaining row |
| F6 | 6 | Backfill merges genuinely different same-name people; journal names become undeletable rows | **Dismissed (specified)**: the issue and ADR explicitly decide "one record per distinct typed name" and defer merge/split; the five live invoices are distinct people |
| F7 | 6 | A very large legacy DB could exceed `busy_timeout` in the backfill and fail boot | **Deferred (not fixed)**: real DB has 5 invoices; noted as a follow-up consideration for large imports |
| F8 | 5 | Invoices created without an id after the backfill never appear on party pages | **Dismissed (compatibility)**: typed-only invoices are an explicit contract path; the debts screen still shows them by name, and the picker is the identity path forward |
| F9 | 4 | Reuse target nondeterministic when same-name parties exist | **Fixed**: `ORDER BY created_at, id LIMIT 1` |
| F10 | 3 | Renaming a party leaves invoice display names stale | **Dismissed**: `counterparty_name` is a historical snapshot by design; renaming the record does not rewrite history |
| F11 | 5 | Uniqueness enforced over raw stored values, not canonical ones | **Dismissed (documented)**: the store is the only writer and normalizes on write; the partial index is the cross-process backstop, per ADR-0007 |
| F12 | 4 | Arbitrary text (`"n/a"`, `"0"`) becomes a unique identity key; unbounded length | **Partially fixed**: input phone is capped at 32 chars in create/update schemas. Rejecting non-numeric junk outright is deferred (could refuse a legitimate note); documented in the report |
| F13 | 3 | Port `PartyUpdate` permitted `{}` → raw drizzle `SET {}` error | **Fixed**: empty patch is a no-op returning the current party; store test covers it |
| F14 | 3 | `withPartyPhoneConflict` maps any unique violation in the unit to a phone conflict | **Dismissed**: the only unique surfaces in that unit are the phone index and the random-uuid activity PK; noted for future writes |
| F15 | 4 | Delete invalidated before navigating, flashing NOT_FOUND on the detail page | **Fixed**: `onDeleted()` (navigate) runs before `invalidateParties` |
| F16 | 4 | Port doc claimed "one read" while `partyDetail` issues four queries | **Fixed**: doc now says "one call for the page" (reads share the serialized connection) |
| F17 | 4 | Unguarded `normalizeInvoiceLegacy` in `partyDetail` could 500 the page | **Fixed**: reuses the dashboard's guarded `mapRecentInvoices` mapper |
| F18 | 2 | `partyDeleteOutputSchema.deleted` is always `true` | **Dismissed**: inert wire field, kept for shape stability |
| F19 | 6 | Hand-rolled create/edit overlays lacked focus trap, Escape, focus restore | **Fixed**: extracted `PartyFormDialog` using `useModalDialog` (same behavior as the delete dialog) |
| F20 | 5 | Picker: no Enter submit in the create panel; active option can scroll out of view; dangling `aria-controls`; missing `aria-haspopup` | **Fixed**: create panel is a `<form>` (Enter submits), active option `scrollIntoView({block:"nearest"})`, `aria-controls` only while open, `aria-haspopup="listbox"`. The `aria-activedescendant` + non-focusable options pattern is the correct combobox model and was kept |
| F21 | 4 | Tab arrows hard-coded LTR in an RTL app | **Fixed**: ArrowLeft advances / ArrowRight goes back, with the APG RTL comment |
| F22 | 4 | Delete-block reason only in a `title` on a disabled button | **Fixed**: an `sr-only` blocked explanation is rendered next to the disabled button |
| F23 | 3 | App-wide invalidation in forms vs keyed invalidation in the picker | **Fixed**: the picker now uses the same `invalidateParties` helper; app-wide is the documented deliberate trade at this scale |
| F24 | 3 | Server-side `PHONE_EXISTS` has no pick affordance | **Dismissed**: the server key carries no record identity; the client-side owner gate covers the loaded-list case and the panel shows the translated key |
| F25 | 3 | `PartyForm` (list/detail) has no duplicate-name warning | **Deferred**: the ADR's warning lives in the picker; adding a same-name check to the form needs the party list in that component — follow-up candidate |
| F26 | 2 | Footer "total remaining" sums the filtered rows | **Fixed**: the footer only renders while the search is empty |
| F27 | 2 | Detail tables lacked `scope="col"` | **Fixed** |
| F28 | 2 | `useParams` assertion instead of route-typed params | **Dismissed**: one component serves both role routes; the SAFETY comment records the route-tree invariant |
| F29 | 2 | تعديل button is an alias for the always-editable «المعلومات» tab | **Dismissed (prototype)**: the issue's prototype defines the header action and the tab form exactly this way |
| F30 | 2 | Arabic copy nits: missing shadda, bare ASCII `+` in RTL, two sentences for one rule | **Fixed**: «تعديل مورّد», `ltrIsolate("+")` on both new-record labels. The short tooltip and the detail hint stay (different surfaces) |

## Fix commit

`5dbb678` — 13 files, +248/−96: contracts phone cap; store `safePartyStats`,
conditional delete, no-op patch, guarded invoice map, deterministic reuse order;
router party validation in `invoicesCreate`; picker form/aria/scroll/invalidation;
`PartyFormDialog` with modal behavior; RTL tab arrows; sr-only delete reason;
filtered-total guard; role-split stats label; copy fixes. New tests: router
wrong/unknown party refusal, store empty patch + negative aggregate clamp,
picker Enter-submit; e2e updated for the role-split label.

## Gates after fixes

- `bun run typecheck` — 3/3 tasks pass
- `bun run lint` — 0 errors
- `bun run test` — 420 web + API suites pass
- `bun run test:e2e` — 38/38 pass (re-verified for the two affected specs, then the full suite)
