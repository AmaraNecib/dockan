# Identity keys: normalize on write, compare canonical, and strip invisible text

**Date:** 2026-10-01 · **Issue:** 120 · **Area:** packages/contracts, apps/api/store, apps/web picker

Issue #120 made a phone the unique identity of a customer/supplier (ADR-0007) and
backfilled legacy invoices by typed name. Three review rounds found the same
class of bug three times in different disguises — worth writing down.

## One canonicalizer, and it must handle the junk

`normalizePartyPhone` (`packages/contracts/src/phone.ts`) is used by the store
**and** by the web picker's matching, so the UI's "this phone already belongs to
X" warning agrees with the store's `PHONE_EXISTS` by construction. Two edges
that only surfaced under review:

- **Separator-only input** (`"..."`, `" - "`) cleaned down to `""`, which is
  *not* null: it became an empty-string identity and the second such walk-in was
  refused with a phone conflict. Return `null` when nothing survives cleaning.
- **Bidi/zero-width marks** (`\u200B-\u200F`, `\u202A-\u202E`, `\u2066-\u2069`,
  `\uFEFF`) are injected by Arabic-first copy/paste (WhatsApp, word processors)
  and `\s` does **not** match them. `"\u200F0550…"` was a second identity.

The same mark bug then recurred in `normalizeTextKey` (names): the backfill
grouped `"علي"` and `"علي\u200F"` as two debtors and the duplicate-name warning
was silent. **Strip the invisible ranges in every text key**, not just phones.

## Compare canonical forms, not raw columns

`assertPhoneFree` first ran `SELECT … WHERE phone = ?` against the raw column.
The partial unique index also compares raw strings, so a row written by a future
import/adapter as `"0550 12 34 56"` would not match a canonical
`"+213550123456"` and the identity rule would leak. Fix: read the rows and
compare `normalizePartyPhone(stored) === normalizePartyPhone(candidate)`. The
index stays as the cross-process backstop; the store check owns the rule.

## A backfill must group by the same key the app matches on

The one-time migration initially grouped by SQL `TRIM(counterparty_name)`. The
app matches names through `normalizeTextKey` (NFC, lowercase, tatweel/harakat
strip, whitespace collapse), so double spaces and diacritics produced duplicate
debtors that the picker would have collapsed. Group the migration by the app's
key, reuse an existing party by that key, and `UPDATE` every raw spelling in the
group; skip names whose JS-trim is empty (SQLite `TRIM` only strips 0x20, so
NBSP-only names slipped through). Reuse-by-name also makes the migration
idempotent even if the marker write is lost — the marker is an optimization, not
the correctness mechanism.

## Aggregate reads must share one source with the rows they summarise

`partyDetail` computed the stats strip with a SQL `SUM` while the invoices tab
mapped the same rows through a guarded legacy normalizer. One malformed row
would be counted in the strip but dropped from the table. Deriving the strip
from the mapped array removes both the disagreement and the duplicated SQL —
and clamping at the edge (`safeWhole`: non-negative whole, ≤ `MAX_SAFE_INTEGER`)
keeps one bad legacy row from failing `dinarsSchema` output validation and
blanking the whole page.

## Process: multi-round review evidence goes stale on every fix

Fixing debate findings after the evidence file is written makes that evidence
stale by the guard's own rule. The cheap discipline: batch review-driven fixes,
then regenerate all three gate files (debate, test-audit, code-review) at the
final SHA in one parallel workflow. The final round's reviewers should read the
earlier evidence files and verify resolutions instead of repeating round 1.

## E2E specs share one database: settle the money you created

A new spec that creates an unpaid debt leaks into every later spec that asserts
group totals (the debts screen sums all parties). The customers spec records
payments at the end (`settleInvoice`) so the shared DB returns to zero debt —
and the comment in the spec says why, so a future edit does not "simplify" the
cleanup away.
