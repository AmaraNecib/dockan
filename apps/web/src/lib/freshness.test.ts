import { describe, expect, it } from "bun:test";

import { HOT_COUNTER_REFETCH_MS, LEDGER_REFETCH_MS, SLOW_REFETCH_MS, hotCounterRefresh } from "./freshness";

/**
 * #295 — the tick bounds are shipped behaviour, so they are pinned here: a
 * typo in the default (`5_000` -> `50_000`) would otherwise pass every test
 * in the repo and silently change how often every window reads the server.
 */
describe("the hot counter tick (#295)", () => {
  it("keeps the bounds where the design doc says they are", () => {
    expect(HOT_COUNTER_REFETCH_MS).toBe(5_000);
    expect(LEDGER_REFETCH_MS).toBe(15_000);
    // the calm cadence the two queries #295 did NOT make hot kept: the
    // pending-return badge and the checklist's progress read
    expect(SLOW_REFETCH_MS).toBe(60_000);
  });

  it("defaults the counter tick to the counter bound, and ticks in the background", () => {
    const options = hotCounterRefresh();
    expect(options.refetchInterval).toBe(HOT_COUNTER_REFETCH_MS);
    expect(options.refetchIntervalInBackground).toBe(true);
  });
});
