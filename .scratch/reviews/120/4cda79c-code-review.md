# Issue #120 — Final code-review evidence (two axes)

- **Reviewed HEAD:** `46a6a8fd5b95b075648ef2ce8cda02bfe3c43f79`
- **Fix commit: 60573aff. Evidence HEAD (this file): 4cda79c33a302ad0fc3b7ba45d990746e7029249**
- **Base:** `8579fcf8f5d2197ec74d7fc01331530aef917957` (`origin/develop`)
- **Diff:** `git diff 8579fcf...HEAD`; commits `8579fcf..HEAD`
- **Method:** two parallel read-only sub-agents (Standards and Spec), aggregated
  verbatim below; the parent then resolved the actionable findings in 60573af.

## Standards (verbatim)

**Correct (verified on 46a6a8f)**
- Wisdom `.agents/wisdom/2026-08-27-items-list-join-seam.md` is honored: joined
  fields go on dedicated seam schemas (`partyListItemSchema =
  partySchema.extend`, `partyPaymentSchema = paymentSchema.extend`,
  `partyListOutputSchema`/`partyDetailOutputSchema`), the entity `partySchema`
  stays lean, and the contract output schemas were extended.
- P1 holds: `invoiceParty` is now «الزبون / المورّد»; «الطرف» is gone.
- P4 holds: `assertPhoneFree` compares `normalizePartyPhone(row.phone)` against
  the candidate, so a raw `"0550 12 34 56"` row cannot escape.
- S5/S6/S3 as previously requested are in place (`safePartyStats(stats ?? {})`,
  `partyInvoiceKind[role]`).
- S1: this gate is the record at its own HEAD.

**Blocker** — none.

**Standards breaches (documented)**
- [medium] "Party" is not a `CONTEXT.md` glossary term. CONTEXT.md defines
  **Customer (عميل)** and **Supplier (مورّد)** only; `docs/development-workflow.md`
  §1 makes the glossary the canonical term list and read-only during
  implementation. `core.ts`, the ten `party*` contract procedures, and the i18n
  keys introduce `party`/`partyRole` with no glossary entry. ADR-0007 names
  "customers and suppliers", never a party.
- [low] `partyStatsSchema` comment "One SQL read serves both the list row and the
  detail stats strip" is false as written: only the mapper is shared.
- [low] The new map's claim "so the role↔kind direction cannot drift" is not yet
  true: kind→role is still hand-written at the router, and the kind↔table pairing
  is re-declared in the backfill.

**Baseline smells (judgement)**
- Repeated Switches / Shotgun Surgery: the role→{list,get,create,update,delete}
  switch is repeated across five web files (round-1 S2/S4, unchanged).
- Duplicated Code: two aggregate SQL blocks compute the same stats.
- Speculative Generality: `safePartyStats(Partial<SqlPartyStats>)` silently
  accepts `{}`; `partyDeleteOutputSchema.deleted` is never false.
- Mysterious Name: the canonical-phone assertion was added inside "keeps the
  partial unique phone index as the cross-process backstop".

## Spec (verbatim)

**Correct / fixed**
- **P1 fixed.** No UI string renders «الطرف»; `invoiceParty` is
  «الزبون / المورّد». Remaining «الطرف» hits are only test fixture names.
- **P4 fixed.** `assertPhoneFree` scans all rows and compares canonical forms.
- **P6 fixed.** Backfill groups by `normalizeTextKey` and re-updates every raw
  spelling; skips JS-whitespace/NBSP-only names.

**Blocker** — none.

**Notes (open / interpretation)**
- **P2 — interpretation, unchanged.** Backfill still role-splits
  (`SALE→customers`, `PURCHASE→suppliers`). The spec's literal "one record per
  distinct typed name" is not what ships; defensible under the two-table model.
- **P3 — scope creep, all present and deliberate.** Phone `.max(32)`, the update
  refine, `invoicesCreate` party validation + authoritative name, `safeWhole`
  clamp, bidi strip, picker phone-owner block. Each hardens a real edge and none
  contradicts a spec line.
- **P5 — still open (low).** The partial unique index runs unguarded at setup; a
  legacy DB with duplicate non-null phones would fail boot. Unreachable today
  because the tables had no writer before this PR.

## Resolution in 60573af

| Finding | Action |
|---------|--------|
| Standards: `partyStatsSchema` comment false | **Fixed**: comment now says the detail derives the strip from the same mapped invoices it renders (and the code now does exactly that) |
| Standards: "cannot drift" claim overstated | **Fixed**: comment now describes the actual single direction the map serves |
| Standards: Duplicated aggregate SQL | **Fixed**: `partyDetail` computes stats from the mapped rows; the second aggregate query is gone |
| Standards: canonical-phone assertion inside the index test | **Fixed**: split into its own `it` |
| Standards: "Party" absent from CONTEXT.md | **Dismissed with rationale**: the workflow makes CONTEXT.md read-only during implementation and routes term changes through an ADR; ADR-0007 owns the identity vocabulary, and the UI uses only زبون/مورّد. Recorded as a docs follow-up candidate for the parent |
| Standards: repeated role switch across web files | **Deferred (recorded)**: thin wire/page adapters; the store owns the shared rule |
| Standards: `deleted` always true, `Partial` accepts `{}` | **Dismissed**: inert/defensive surface kept for shape stability |
| Spec P2 role-split backfill | **Dismissed (documented)**: SALE invoices belong to customers, PURCHASE to suppliers; the five live names map correctly |
| Spec P3 scope creep | **Accepted as deliberate hardening**, listed in the handoff |
| Spec P5 unguarded index at setup | **Dismissed**: tables were unreachable before this feature, so duplicates cannot exist; fail-loud is the migration policy |

## Post-fix gates at 60573af

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 430 web tests + API suites pass
- `bun run test:e2e` — 38/38 pass
