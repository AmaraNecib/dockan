import type { QueryClient } from "@tanstack/react-query";

import { orpc } from "./rpc";

/**
 * #323 — one party, one cache identity.
 *
 * A party is named by its id when the shop has a record for it and by the
 * operator-typed name when it does not, and the two screens that read a
 * party's balance sent DIFFERENT inputs for the same party: the invoice
 * screen's customer tab carried the id alone, the debts screen's drill-down
 * carried the id AND the name. Two cache keys for one party means a payment
 * invalidated one of them, so the other screen kept previewing a refund
 * against a total the write had already moved.
 *
 * The rule here is the SERVER's, not a new one: `debtsByPartyInputSchema`
 * says an id is authoritative (the store matches on it and the name only
 * labels the request) and that a typed party is matched on its trimmed name.
 * One rule, one key, both screens.
 */

/** which side of the ledger a party is on: a customer (SALE) or a supplier (PURCHASE) */
export type PartyBalanceKind = "SALE" | "PURCHASE";

/** a party as the screens know it: an id when the shop has a record, else the typed name */
export type PartyBalanceIdentity = {
  kind: PartyBalanceKind;
  counterpartyId: string | null;
  counterpartyName: string | null;
};

/** the `debtsByParty` input of one party */
export type PartyBalanceInput = {
  kind: PartyBalanceKind;
  counterpartyId: string | null;
  counterpartyName: string | null;
};

/**
 * The canonical input for a party, or null when the party has NO identity at
 * all: no id and no usable name. The read is refused then, because such a
 * key would be the key of every other nameless party.
 */
export function partyBalanceInput(identity: PartyBalanceIdentity): PartyBalanceInput | null {
  const id = identity.counterpartyId?.trim() ?? "";
  if (id !== "") return { kind: identity.kind, counterpartyId: id, counterpartyName: null };
  const raw = identity.counterpartyName ?? "";
  const name = raw.trim();
  if (name === "") return null;
  // #323 review — a name the trim CHANGED is not addressable, so it is refused
  // rather than looked up.
  //
  // The wire contract trims with JavaScript semantics
  // (`packages/contracts/src/core.ts` `counterpartyName: z.string().trim()`),
  // while `debtSummaries` groups by the RAW `COALESCE(counterparty_id,
  // counterparty_name)` and `debtsByParty` matches with sqlite's `TRIM()`, which
  // strips U+0020 only. A stored name padded with anything JavaScript strips and
  // sqlite does not (NBSP, U+3000, tab, U+FEFF) therefore cannot be asked for at
  // all: the request leaves as the trimmed name, the store matches the UNPADDED
  // party, and the padded row's drill-down draws another party's unpaid invoices
  // under its own label. One party's money under another party's name is worse
  // than a refusal, and refusing is the only honest answer a client has, because
  // no client-side input can express the padded query.
  //
  // The repair belongs on the server — one identity rule, so the GROUP BY and the
  // WHERE trim the same way — and is filed as its own issue. This branch stops the
  // mis-attribution without pretending to fix it.
  if (name !== raw) return null;
  return { kind: identity.kind, counterpartyId: null, counterpartyName: name };
}

/**
 * Mark a party's balance read stale after a write that moved the party's
 * money. The key is the SAME key both screens read under, so an open screen
 * moves without a manual refresh.
 *
 * This reaches the writing window's cache only. A second window has its own
 * QueryClient (`apps/web/src/main.tsx`), so nothing here tells it anything —
 * the reads carry a bounded tick instead (`lib/freshness.ts`), which is the same
 * answer #295 gave the counters for the #294 multi-window gap. Two windows side
 * by side never exchange a focus event, so the tick is the only thing that
 * converges them.
 */
export function invalidatePartyBalance(queryClient: QueryClient, identity: PartyBalanceIdentity): Promise<void> {
  const input = partyBalanceInput(identity);
  if (input === null) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: orpc.debtsByParty.queryKey({ input }) });
}
