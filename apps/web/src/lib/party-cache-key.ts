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
  const name = identity.counterpartyName?.trim() ?? "";
  if (name === "") return null;
  return { kind: identity.kind, counterpartyId: null, counterpartyName: name };
}

/**
 * Mark a party's balance read stale after a write that moved the party's
 * money. The key is the SAME key both screens read under, so an open screen
 * moves without a manual refresh.
 */
export function invalidatePartyBalance(queryClient: QueryClient, identity: PartyBalanceIdentity): Promise<void> {
  const input = partyBalanceInput(identity);
  if (input === null) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: orpc.debtsByParty.queryKey({ input }) });
}
