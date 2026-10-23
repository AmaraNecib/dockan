import type { DebtsByPartyInput } from "@dokan/contracts";

import { hotCounterRefresh, PARTY_BALANCE_REFETCH_MS } from "./freshness";
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
 * One rule, one key, both screens. #337 — the server's trim set is the same
 * JavaScript set this file trims with (`apps/api/src/store/trim-chars.ts`), so
 * a typed party has one identity on both sides of the wire and no spelling of
 * it has to be refused.
 */

/** which side of the ledger a party is on: a customer (SALE) or a supplier (PURCHASE) */
export type PartyBalanceKind = "SALE" | "PURCHASE";

/** a party as the screens know it: an id when the shop has a record, else the typed name */
export type PartyBalanceIdentity = {
  kind: PartyBalanceKind;
  counterpartyId: string | null;
  counterpartyName: string | null;
};

/**
 * The `debtsByParty` input of one party — the contract's own type, not a copy of
 * it (#340). A hand copy keeps compiling when the schema gains a field, and the
 * key it produces then differs from every other key for the same party: #323
 * again, silently.
 */
export type PartyBalanceInput = DebtsByPartyInput;

/**
 * The canonical input for a party, or null when the party has NO identity at
 * all: no id and no usable name. The read is refused then, because such a
 * key would be the key of every other nameless party.
 *
 * #337 — the name is trimmed here with JavaScript's rule, and the server now
 * applies the SAME set on its side (`apps/api/src/store/trim-chars.ts`, used by
 * both the debts GROUP BY and the drill-down's WHERE), returning an already
 * trimmed label. So the trimmed name is not an approximation of the stored one:
 * it is the identity the server itself computes, which is why nothing that
 * JavaScript's trim can change has to be refused any more.
 */
export function partyBalanceInput(identity: PartyBalanceIdentity): PartyBalanceInput | null {
  const id = identity.counterpartyId?.trim() ?? "";
  if (id !== "") return { kind: identity.kind, counterpartyId: id, counterpartyName: null };
  const name = (identity.counterpartyName ?? "").trim();
  if (name === "") return null;
  return { kind: identity.kind, counterpartyId: null, counterpartyName: name };
}

/**
 * What a party-money write needs from the cache: the ONE method it calls. Typing
 * the parameter as the whole `QueryClient` would make every caller and every test
 * carry the full surface, and a test double would need a cast to narrow it back
 * down — the port is the honest interface (and `QueryClient` satisfies it
 * structurally, so callers pass theirs unchanged).
 */
export type CacheInvalidator = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => Promise<void>;
};

/**
 * #340 — a write that moves a party's money refreshes every read that shows it.
 *
 * `invalidatePartyBalance` answered one question (the balance key) while every
 * writer needed three, so each of the six money-write sites listed the extras by
 * hand: `reportsDebts` and `activitiesList`. #336 is the evidence that this does
 * not survive contact with a new panel — `reportsDebts` was missing from FOUR of
 * the six and had to be added by hand in that same branch.
 *
 * The always-true core lives here. A caller adds only its own extras
 * (`customersGet`, `invoicesList`, `itemsAll`), which are genuinely per-write.
 *
 * Returns the promise so a caller can await the refresh, and resolves without
 * invalidating when the party has no identity at all: an unidentified party's
 * key is every other nameless party's key.
 */
export function invalidatePartyMoney(queryClient: CacheInvalidator, identity: PartyBalanceIdentity): Promise<void> {
  const input = partyBalanceInput(identity);
  if (input === null) return Promise.resolve();
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.debtsByParty.queryKey({ input }) }),
    // the debts list's totals: per-party money is part of that list's answer
    queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
    // the activity feed shows the write that moved the money
    queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
  ]).then(() => undefined);
}

/**
 * The party balance read, as query options — the seam that owns "is this party
 * addressable at all" (#340, item 3).
 *
 * Both read sites wrote the same three lines: fabricate a throwaway input so the
 * key stays well-formed, disable the query when there is no identity, and add the
 * bounded tick. That is an interface saying "here is a key, be careful never to
 * use it", which is one refactor away from reading under a nameless party's key.
 *
 * `enabled` is ANDed with the caller's own condition, so a screen that only reads
 * a balance in one mode keeps saying so.
 */
export function partyBalanceQueryOptions(
  identity: PartyBalanceIdentity,
  options: { refreshMs?: number; enabled?: boolean } = {},
): ReturnType<typeof orpc.debtsByParty.queryOptions> & { enabled: boolean } & ReturnType<typeof hotCounterRefresh> {
  const input = partyBalanceInput(identity);
  // the raw identity keeps the key well-formed for the disabled entry. It is
  // never read under: `enabled` is false and invalidation never re-enables a
  // disabled query.
  const wellFormed: DebtsByPartyInput = {
    kind: identity.kind,
    counterpartyId: identity.counterpartyId,
    counterpartyName: identity.counterpartyName,
  };
  return {
    ...orpc.debtsByParty.queryOptions({ input: input ?? wellFormed }),
    enabled: (options.enabled ?? true) && input !== null,
    ...hotCounterRefresh(options.refreshMs ?? PARTY_BALANCE_REFETCH_MS),
  };
}

/**
 * The documented exception to the write rule above: a BATCH write over N parties,
 * where typed rows may create suppliers whose ids do not exist yet, sweeps the
 * whole `debtsByParty` key instead (`supplier-opening-balance.tsx`). Anywhere else
 * a write goes through `invalidatePartyMoney` — grepping for how to invalidate a
 * party tab must find one answer.
 */
