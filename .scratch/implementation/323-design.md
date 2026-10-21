# #323 — one party, one cache identity

## The defect

A party is named by its **id** when the shop has a record for it and by the
**operator-typed name** when it does not. Two screens read a party's balance
and sent different inputs for the same party:

| screen | `debtsByParty` input before |
| --- | --- |
| invoice screen, customer tab (`pages/invoice.tsx`) | `{kind:"SALE", counterpartyId: id, counterpartyName: null}` |
| debts screen, drill-down (`pages/debts.tsx`) | `{kind, counterpartyId: id, counterpartyName: name}` |

oRPC keys a query as `[path, {input, type}]`, so those are **two cache entries
for one party**. The customer settle panel's payment invalidated
`customersGet` and the invoice lists — neither `debtsByParty` key — so an open
invoice screen kept previewing a refund against a total the payment had
already moved.

## The rule (the server's, not a new one)

`debtsByPartyInputSchema` (`packages/contracts/src/core.ts`) already states it:

- an **id is authoritative** — the store matches on it and the name only labels
  the request, so a mismatched name cannot re-route invoices to another party;
- a party **without** an id is matched on its **trimmed name**.

So the canonical input is: the id when there is one (the name dropped), the
trimmed typed name otherwise, and **nothing** when there is neither — the
contract refuses that input, and a client key built from it would be the key
of every other nameless party.

The client key must be a function of exactly what the server matches on.
Folding the name the way the *identity* fold does (`normalizeTextKey`,
ADR-0007) would merge «أحمد» and «احمد» — two parties the server keeps apart —
into one cache entry, and one screen would show the other's money. The trim
the store uses is the only safe fold here.

## The shape

`apps/web/src/lib/party-cache-key.ts`:

- `partyBalanceInput(identity)` → the canonical `debtsByParty` input, or
  `null` when the party has no identity at all.
- `invalidatePartyBalance(queryClient, identity)` → invalidates the **exact**
  key of that read (the write side). A party with no identity is a no-op: the
  read is refused, not broadcast.

`invalidatePartyBalance` builds the key through `orpc.debtsByParty.queryKey`,
the same generator `queryOptions` uses for the read, so the invalidated key and
the read key cannot drift.

## The call sites

Reads (both screens now read one key):

- `pages/debts.tsx` — the drill-down.
- `pages/invoice.tsx` — the returns panel's customer tab.

Writes (every party-money write invalidates that key, plus the debts list that
shows every party's total):

- `components/parties/customer-settle-panel.tsx` — the customer payment.
- `pages/invoice.tsx` — the invoice payment.
- `components/parties/supplier-{pay,refund,return,adjust}-panel.tsx`.

The supplier adjust panel used to sweep the whole `debtsByParty` family
(`[["debtsByParty"]]`); it now invalidates **its** party. The family prefix
stays only for the opening-balance bulk write, which spans many suppliers at
once.

## The refusal

A party with neither an id nor a usable name (a row that bypassed the
contract) has no key to read under. The debts screen shows one sentence
(`debtsPartyUnidentified`, a new i18n key) instead of a read that would fail
on the server with a message the owner cannot act on.

## The proof

`apps/web/src/pages/party-balance-identity.test.tsx` drives the real screens on
one query cache, the way two open tabs share it:

1. the debts screen and the invoice screen hold **one** cache entry for the
   party, and its key carries the id alone;
2. a payment recorded on the party screen moves the invoice screen's refund
   preview from "off the debt" (900 / 0) to "cash" (0 / 900) — no manual
   refresh.

Both tests are red on the parent commit (`218953a8`): the first sees two
entries for one party, the second sees a preview that never moves.
