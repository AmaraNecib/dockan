# 253 — activity log: raw keys, id-as-reference, and the untranslated diagnostics rows

**Tier: Standard.** The brief pins it. Justification (checked against the five
High-assurance failure modes): the diff is display copy plus a read-only log
projection. It touches no stock quantity, no invoice/payment arithmetic, no auth
rule and no backup path. The debt-direction half is a *label* concern: the page
maps the stored `WE_OWE`/`THEY_OWE` token to the **same i18n keys the supplier
account screen already uses** (`supplier-entry-display.ts` → #252 owns those
labels), never to a sign or a balance. The activity page computes no direction;
it prints the one the server stored.

Base: `origin/develop` merge-base = `d843566` (recorded after `git fetch`).

## What the ticket exposes

1. `apps/api/src/rpc/router.ts:1120` writes `summary: SUPPLIER_OPENING_BALANCE
   <direction> <amount> <name>` and `:1000` writes `SUPPLIER_ADJUSTMENT …`.
   `apps/web/src/pages/activity.tsx` has no branch for either tag, so the row
   prints verbatim.
2. The **type badge** leaks too: `activityType_PARTY_UPDATED`,
   `activityType_PARTY_DELETED` and `activityType_ADJUSTMENT_RECORDED` are absent
   from the catalogue, so `ADJUSTMENT_RECORDED` renders as a raw key.
3. `activity.tsx:17 formatActivityReference` prints `ref.slice(0, 8)` — an opaque
   id with no way to reach the record.
4. The diagnostics viewer (`apps/web/src/pages/diagnostics.tsx`) renders the JSONL
   `event` badge and `message` verbatim. The owner named the first-run boot rows:
   *First-time setup* (`FIRST_TIME_SETUP`), *Owner account created*
   (`"owner account created"`), *Vault created and unlocked*
   (`VAULT_CREATED "vault created and unlocked"`), *Server boot done*
   (`SERVER_BOOT_DONE`, both message variants), *Port stored* (`SERVER_STARTED`)
   — the strings live only in the API's `logger.info(event, message, ctx)` call
   sites (`apps/api/src/main.ts`, `lib/vault/*.ts`, `rpc/router.ts`). Those call
   sites are the one source.

## Decisions

**D1 — the tag vocabulary is a shared contract constant.** `activitySummaryTags`
lands in `packages/contracts/src/core.ts` next to `activityTypes`. The server
already imports `activityTypes` from there, so the vocabulary has one home and
both sides can enumerate it.

**D2 — the direction word is a shared i18n key, not a new string.**
`WE_OWE` → `supplierAdjustDirectionWeOwe`, `THEY_OWE` →
`supplierAdjustDirectionTheyOwe`. If #252 lands its swap, the activity log
follows automatically and can never disagree with the supplier account page. The
acceptance example's «علينا» is the owner's *intent* for a row #252 records as
`THEY_OWE` (the swapped-label symptom); reusing the canonical key is what keeps
one truth.

**D3 — amounts stay raw digits.** Every other activity sentence prints the stored
integer (`تسجيل دفعة 5000 دج`). Grouping only the opening-balance row would make
one sentence disagree with the rest; a grouped amount formatter is a separate
cross-cutting change.

**D4 — the reference column becomes a link where a route exists.** A pure
`activityRefLink(entry)` maps the row to a detail route (`/items/$itemId/history`,
`/invoices/$invoiceId`, `/customers|suppliers/$partyId`); rows with no route
(expense, return voucher, backup) keep their compact id/filename. The raw id stays
the link text (it is the record's identity), and the link is what answers "what is
this column?".

**D5 — diagnostics translates a bounded boot vocabulary with a raw fallback.**
`logEvents` (contracts) is the shared event vocabulary; `logEventCopy` maps every
member to a `logEvent_<code>` Arabic badge, and `logMessageCopy` maps the fixed
startup messages the owner named. A message outside that map renders exactly as
today, and the raw `event` code stays in the DOM (`data-event`, `title`) so
support can still search it. Translating every dynamic failure sentence is out of
scope and would move the debugging text further from the log.

## Interfaces

```ts
// packages/contracts/src/core.ts
/** activity summary tags the api can write */
export const activitySummaryTags = [ … ] as const;
export type ActivitySummaryTag = (typeof activitySummaryTags)[number];
/** JSONL log event codes the api can write */
export const logEvents = [ … ] as const;
export type LogEvent = (typeof logEvents)[number];

// apps/web/src/pages/activity.tsx
export function activitySummaryText(t: TFunction, summary: string): string; // unchanged
/** the tag (not the type) decides the target, because one type carries several
 * tags with different refs (STOCK_ADJUSTED/STOCK_LINKED, PAYMENT_RECORDED/
 * SUPPLIER_*) */
export function activityRefLink(entry: { summary: string; ref: string | null }):
  | { to: "/invoices/$invoiceId"; params: { invoiceId: string } }
  | { to: "/items/$itemId/history"; params: { itemId: string } }
  | { to: "/customers/$partyId"; params: { partyId: string } }
  | { to: "/suppliers/$partyId"; params: { partyId: string } }
  | null;

// apps/web/src/lib/log-copy.ts
export function logEventCopy(t: TFunction, event: string): string;
export function logMessageCopy(t: TFunction, event: string, message: string): string;
```

## Tests

- `apps/web/src/pages/activity.test.tsx` — **enumeration guard**: the fixture map
  must cover exactly `activitySummaryTags` (set equality + no duplicates) and
  exactly `activityTypes`; every fixture renders translated copy with no leaked
  tag; the acceptance row asserts the Arabic sentence; the ref-link map is tested
  per row shape.
- `apps/api/src/rpc/activity-tags.test.ts` — source scan: every `summary:` literal
  tag emitted under `apps/api/src` is in `activitySummaryTags` (a new server tag
  fails here). No reverse check: `PASSWORD_RESET` is a carried-over type with no
  current emit site, and the four `VAULT_*` tags come through `recordFailure`.
- `apps/web/src/lib/log-copy.test.ts` — every `logEvents` member has Arabic copy,
  the named boot messages translate, the two `SERVER_BOOT_DONE` variants differ,
  and unknown event/message render raw.
- `apps/api/src/lib/log-events.test.ts` — source scan: every logger/`recordFailure`
  /`rotateSession` event literal is a member of `logEvents`.
- `apps/web/src/pages/diagnostics.test.tsx` — boot rows render Arabic, `data-event`
  keeps the raw code, unknown rows still render raw.
- `tests/e2e/activity.spec.ts` — the real category+item flow still lists Arabic
  copy newest first, and the item row's ref is now a link into
  `/items/$itemId/history`.
- `tests/e2e/diagnostics.spec.ts` — the seeded RPC_ERROR row shows the Arabic
  badge with `data-event="RPC_ERROR"` and its DKN code.

**Why the acceptance row has no e2e seed.** An opening balance adds a supplier
account to the shared e2e database, which changes the global `/debts` totals that
`debts.spec.ts` (`1200 دج`, count 1) and `supplier-adjustment.spec.ts` (net-credit
group) assert by exact value. Adding one would break two sibling specs; the
acceptance sentence is pinned by `activity.test.tsx` (both directions) and by the
real-app before/after screenshots instead.

## Evidence (see the commit body)

Before/after images and a real-pace video live in `.scratch/reviews/253/`
(`before-activity.png`, `after-activity.png`, `before-diagnostics.png`,
`after-diagnostics.png`, `before-video.webm`, `after-video.webm`). The failing-first
proof is an ablation: the new guards were re-run with the fix and with the fix
removed, on this HEAD.

## Risks

- The direction word follows #252. If #252 lands after this, no change is needed
  here (shared key). If it lands first, the rendered word changes — intended.
- `activitySummaryTags` must include the four vault-failure tags, which are
  emitted through `recordFailure(event)`; the api scan sees them through the
  `recordFailure("…")` pattern, and the web enumeration asserts a branch for
  every member.
- The direction word follows #252. On develop the two `supplierAdjustDirection*`
  labels are still swapped, so the `WE_OWE` row renders «نسالوه» today and
  «يسالنا» once #252 lands — the activity page needs no change either way.
