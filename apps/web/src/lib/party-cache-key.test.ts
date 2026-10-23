import { describe, expect, it } from "bun:test";

import { invalidatePartyMoney, partyBalanceInput, partyBalanceQueryOptions, type CacheInvalidator } from "./party-cache-key";

/**
 * #340 — the money-write invariant and the addressability seam.
 *
 * The bug this pins is not a mistake in one site, it is that the sites each
 * re-listed the keys: #336 is the evidence, where `reportsDebts` was missing from
 * four of six writers. So the first test asserts the SET, read from the module's
 * own answer rather than restated here — the same reason the gate's arm 1 reads
 * the instance's options instead of a copy.
 */

type Recording = { queryClient: CacheInvalidator; keys: string[] };

function recordingClient(): Recording {
  const keys: string[] = [];
  return {
    queryClient: {
      invalidateQueries: (filters) => {
        keys.push(JSON.stringify(filters.queryKey));
        return Promise.resolve();
      },
    },
    keys,
  };
}

const party = { kind: "SALE" as const, counterpartyId: "party-1", counterpartyName: null };
const typedParty = { kind: "SALE" as const, counterpartyId: null, counterpartyName: "زبون" };
const nameless = { kind: "SALE" as const, counterpartyId: null, counterpartyName: null };

describe("#340 the party-money write invariant", () => {
  it("invalidates the whole core set, and every key in it is a read that shows the party's money", async () => {
    const { queryClient, keys } = recordingClient();

    const promise = invalidatePartyMoney(queryClient, party);
    // it returns the promise: a caller that awaits the refresh exists
    expect(promise).toBeInstanceOf(Promise);
    await promise;

    expect(keys).toHaveLength(3);
    const joined = keys.join("\n");
    expect(joined).toContain("debtsByParty");
    expect(joined).toContain("reportsDebts");
    expect(joined).toContain("activitiesList");

    // and a party with NO identity is not written under: that key would be every
    // nameless party's. Asserted here rather than alone, because on the parent a
    // no-op stand-in also invalidates nothing and a standalone test could not tell.
    const namelessRun = recordingClient();
    await invalidatePartyMoney(namelessRun.queryClient, nameless);
    expect(namelessRun.keys).toEqual([]);
  });

  it("uses the party's id when it has one, and its trimmed name when it does not", async () => {
    const byId = recordingClient();
    await invalidatePartyMoney(byId.queryClient, party);
    expect(byId.keys.join("\n")).toContain("party-1");

    const byName = recordingClient();
    await invalidatePartyMoney(byName.queryClient, typedParty);
    expect(byName.keys.join("\n")).toContain("زبون");
  });

});

describe("#340 the addressability seam", () => {
  it("disables the read when there is no identity, and says which key it was disabled under", () => {
    const options = partyBalanceQueryOptions(nameless);
    expect(options.enabled).toBe(false);
    // the key stays well-formed so an invalidation cannot match a different
    // party's entry; nothing is ever read under it
    expect(JSON.stringify(options.queryKey)).toContain("debtsByParty");
  });

  it("enables the read for an identified party and keeps the caller's own condition", () => {
    expect(partyBalanceQueryOptions(party).enabled).toBe(true);
    expect(partyBalanceQueryOptions(party, { enabled: false }).enabled).toBe(false);
    expect(partyBalanceQueryOptions(nameless, { enabled: true }).enabled).toBe(false);
  });

  it("carries the bounded tick so a second window converges without a focus event (#323)", () => {
    const options = partyBalanceQueryOptions(party);
    expect(options.refetchInterval).toBeGreaterThan(0);
    // injectable, so a test can run the wiring on a fast clock
    const fast = partyBalanceQueryOptions(party, { refreshMs: 20 });
    expect(fast.refetchInterval).toBe(20);
  });
});

// red-on-parent-waive: "reads an id-backed party by id alone, and a typed party by its trimmed name" — this arm pins behaviour that must NOT change: #340 adds a seam around the identity rule, it does not alter it, so the parent already answers correctly and the test is a regression guard by design
describe("#340 the identity rule itself is unchanged by the seam", () => {
  it("reads an id-backed party by id alone, and a typed party by its trimmed name", () => {
    expect(partyBalanceInput(party)).toEqual({ kind: "SALE", counterpartyId: "party-1", counterpartyName: null });
    expect(partyBalanceInput({ ...typedParty, counterpartyName: "  زبون  " })).toEqual({
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون",
    });
    expect(partyBalanceInput(nameless)).toBeNull();
  });
});
