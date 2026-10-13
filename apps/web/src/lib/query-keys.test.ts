import { describe, expect, it } from "bun:test";

import { ACTIVITIES_LIST_QUERY_KEY, DEBTS_BY_PARTY_QUERY_KEY, INVOICES_LIST_QUERY_KEY } from "./query-keys";

/**
 * These are PREFIX keys for React Query's non-exact `invalidateQueries`: the
 * generated oRPC key is `[path, { input?, type }]`, so the prefix must equal the
 * first element and match a key that carries an input. This pins that contract
 * so a rename or a key-shape change cannot silently turn the invalidation back
 * into a no-op (Greptile round 1 finding 5).
 */
const prefixMatches = (filter: readonly unknown[], key: readonly unknown[]): boolean =>
  filter.length <= key.length && filter.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));

describe("supplier-money query key prefixes", () => {
  it("match a generated key that carries an input, and only its own family", () => {
    const input = { kind: "PURCHASE" as const, counterpartyId: "s-1", counterpartyName: null };

    expect(prefixMatches(DEBTS_BY_PARTY_QUERY_KEY, [["debtsByParty"], { input, type: "query" }])).toBe(true);
    expect(prefixMatches(DEBTS_BY_PARTY_QUERY_KEY, [["reportsDebts"], { type: "query" }])).toBe(false);

    expect(prefixMatches(INVOICES_LIST_QUERY_KEY, [["invoicesList"], { input: { limit: 10 }, type: "query" }])).toBe(true);
    expect(prefixMatches(ACTIVITIES_LIST_QUERY_KEY, [["activitiesList"], { input: { limit: 20 }, type: "query" }])).toBe(true);
  });

  it("do not match the old dead literal", () => {
    expect(prefixMatches(DEBTS_BY_PARTY_QUERY_KEY, [["debtsData"]])).toBe(false);
  });
});
