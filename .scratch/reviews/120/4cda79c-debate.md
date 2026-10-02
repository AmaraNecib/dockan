# Issue #120 — Final debate evidence (round 2, High-assurance)

- **Reviewed HEAD:** `46a6a8fd5b95b075648ef2ce8cda02bfe3c43f79`
- **Fix commit: 60573aff. Evidence HEAD (this file): 4cda79c33a302ad0fc3b7ba45d990746e7029249**
- **Base:** `8579fcf8f5d2197ec74d7fc01331530aef917957` (`origin/develop`)
- **Round 1:** `.scratch/reviews/120/5dbb678-debate.md` (critic + defender on the first
  implementation; 30 findings, all resolved/dismissed with reasons).

## Round-2 verdicts

- **Critic:** "No blocker. I found no path that corrupts, loses, or mis-states money:
  the backfill's only write is `invoices.counterparty_id`, amounts are untouched,
  the delete rule is enforced at statement level, phone uniqueness is enforced
  twice (store canonical scan + partial unique index), and the `invoicesCreate`
  role check closes the orphan/wrong-role path."
- **Defender:** "The final HEAD is a coherent, well-factored implementation of
  ADR-0007. The three follow-up rounds did not paper over problems — the round-1
  fixes are substantive changes to control flow and data rules … Confidence that
  the implementation matches the design and the ADR: **9/10**."

The critic verified every round-1 fix in code (F1, F2, F4, F5, F9, F13, F15–F17,
F19–F22, F26, F27, F30) and accepted the round-1 dismissals (F6, F8, F10, F14,
F18, F24, F28, F29). F7/F12/F25 remained open as noted below.

## Round-2 findings and resolution

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| N1 / E1 | 6 | Bidi/zero-width marks were stripped from phones but **not from names**: `\u200F` in a pasted name split the backfill group and silenced the picker's duplicate-name warning | **Fixed at 60573af**: `normalizeTextKey` now strips the invisible ranges (same set as phones) before matching; store test groups `"علي"` + `"علي\u200F"` into one party with 2 invoices; pure test asserts the picker warning and filter see through the mark |
| N2 | 6 | The marker makes linking one-shot forever; imports after first boot stay unlinked | **Dismissed (specified)**: issue #120 says "one-time backfill"; typed-only invoices are a supported contract path and the debts screen still shows them. Re-link tooling is a candidate follow-up, not this lane |
| N3 / F7 | 6 | A backfill failure inside `setup()` prevents boot | **Dismissed with rationale, documented inline**: every migration in this file is fail-loud (e.g. `ensureSaleColumns`); silently booting into name-grouped debts would be worse. The live DB has 5 invoices; large-import robustness is a follow-up |
| N4 | 6 | The detail stats strip (SQL aggregate) and the invoices tab (mapped rows) could disagree when a legacy row fails normalization | **Fixed at 60573af**: `partyDetail` derives the strip from the same mapped rows it renders, which also removes the duplicated aggregate SQL; contract comment now states the real mechanism |
| N5 | 5 | Silent clamp; a negative (credit) remaining renders as 0 | **Dismissed (deliberate degrade)**: the clamp exists so one malformed legacy row cannot blank the page (dashboard precedent); credit display is out of scope. Logging the coercion was judged not worth a store logger dependency here |
| N6 / F12 | 5 | Arbitrary short text (`"n/a"`) is still a unique identity key | **Partially fixed earlier** (32-char cap + picker mirror). Rejecting non-numeric junk outright is deferred (could refuse a legitimate note); recorded in the handoff as a follow-up candidate |
| N7 | 5 | Create affordance hidden on list error; panel state on query clear | **Dismissed**: the error row already offers retry (the right recovery), and `handleQueryChange` already closes the panel on every keystroke — no stale values can reappear |
| N8 | 4 | Escape did not close the picker's create panel from its own fields | **Fixed at 60573af**: the panel form handles Escape (stopPropagation + close) |
| N9 | 4 | `max(32)` had no client mirror | **Fixed at 60573af**: `maxLength={32}` on the picker and form phone inputs |
| N10 / F3 | 4 | Delete is kind-agnostic while stats are kind-scoped (legacy/wrong-role rows only) | **Dismissed**: `invoicesCreate` role validation makes the mismatch unreachable for new data; the delete rule is the safety net by design |
| N11 | 3 | No FK on `invoices.counterparty_id` | **Dismissed**: adding a REFERENCES to an existing table needs a table rebuild; ADR-0003 keeps the store as the guarantee. Documented |
| N12 | 3 | The backfill re-declared the role→kind map | **Fixed at 60573af**: the backfill's kind/table list derives from `partyInvoiceKind` + `PARTY_TABLES` |
| N13 | 3 | `PARTY_UPDATED` written for no-op saves | **Dismissed**: an explicit save click is a real user action; value-diffing adds a read for cosmetic log tidiness |
| N14 | 3 | Picker is a controlled/uncontrolled hybrid | **Dismissed**: both parents echo verbatim; the sync effect is the documented contract of the component |
| N15 / E2 | 4 | `normalizeTextKey` does not fold alef/ya variants, so ADR-0007's «علي علي»/«على علي» example still splits | **Deferred (documented)**: the ADR defers merge; folding letter variants globally would change catalog/category matching for every feature, not only parties. A picker-only Arabic fold is a candidate follow-up |
| N16 | 2 | Bidi-ambient names in `aria-label` interpolations | **Dismissed (cosmetic)**: the label text is read, not laid out; the visible strings use the existing isolation helpers |
| N17 | 2 | Zero-total invoice renders «مدفوعة» | **Dismissed**: the same status derivation the invoices list already uses; changing it is a separate product decision |
| N18 | 2 | `ORDER BY p.name` binary collation | **Dismissed**: pre-existing app-wide ordering behaviour |
| E3 | 4 | `safeWhole` clamped only the low end | **Fixed at 60573af**: the high end clamps to `MAX_SAFE_INTEGER`; store test inserts an above-max aggregate |

## Fix commit 60573af

9 files, +244/−29: bidi-safe `normalizeTextKey`; high-end clamp; `partyDetail`
stats from mapped rows (one source); backfill kinds derived from
`partyInvoiceKind`; picker Escape + `maxLength`; tests for the bidi backfill
group, the high clamp, the canonical raw-row refusal (split out of the index
test), the purchase picker id wiring, the list edit dialog, the detail delete
success, and the «الزبون / المورّد» label guard.

## Gates at 60573af

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 430 web tests + API suites pass (232 in the two touched API files)
- `bun run test:e2e` — 38/38 pass
