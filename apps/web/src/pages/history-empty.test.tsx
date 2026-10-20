import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { LEDGER_REFETCH_MS } from "../lib/freshness";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";
import { routerMock } from "../tests/router-mock";

mock.module("@tanstack/react-router", () => routerMock({ itemId: "00000000-0000-4000-8000-0000000000aa" }));

interface MovementFixture {
  id: string;
  occurredAt: string;
  kind: string;
  delta: number;
  unitCost: number | null;
  stockAfter: number;
  reason: string | null;
  createdAt: string;
}

let movements: MovementFixture[] = [];

/**
 * One ledger row, with a FIXED id.
 *
 * A row's running balance can change without the row changing: a movement
 * recorded with an earlier date re-projects the rows after it, so the same
 * row answers a later read with a different balance. That is what the mock
 * below stands for — one row, one id, one number that moves.
 */
function movementRow(): MovementFixture {
  return {
    id: "m-1",
    occurredAt: "2026-08-25T10:00:00",
    kind: "PURCHASE",
    delta: 6,
    unitCost: 400,
    stockAfter: 6,
    reason: null,
    createdAt: "2026-08-25T10:00:00",
  };
}

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration.
mock.module("@/lib/rpc", () => ({
  orpc: {
    itemsHistory: {
      queryOptions: () => ({
        queryKey: ["itemsHistory"],
        queryFn: async () => ({ movements, total: movements.length }),
      }),
      queryKey: () => ["itemsHistory"],
    },
  },
  rpcClient: {},
}));

const { ItemHistoryPage } = await import("./stock");

describe("ItemHistoryPage empty state (issue #96)", () => {
  beforeEach(() => {
    movements = [];
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await unmountAllMountedPages();
    document.body.innerHTML = "";
  });

  it("explains what fills a read-only ledger", async () => {
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-empty") !== null, "history-empty");

    const empty = page.query("history-empty");
    expect(empty?.textContent).toContain(i18n.t("historyEmpty"));
    expect(empty?.textContent).toContain(i18n.t("historyEmptyHint"));
    // no invented action on a read-only ledger
    expect(empty?.querySelector("button, a")).toBeNull();
    expect(page.query("history-table")).toBeNull();
  });

  it("does not show the empty state once a movement exists", async () => {
    movements = [
      {
        id: "m1",
        occurredAt: "2026-08-25T10:00:00",
        kind: "PURCHASE",
        delta: 5,
        unitCost: 400,
        stockAfter: 5,
        reason: null,
        createdAt: "2026-08-25T10:00:00",
      },
    ];
    const page = await mountWithProviders(<ItemHistoryPage />);
    await page.poll(() => page.query("history-table") !== null, "history-table");

    expect(page.query("history-empty")).toBeNull();
  });
});

/**
 * #295 — the running stock column on the ledger screen is a hot counter too:
 * a sale or an adjustment posted in another window has to show up here without
 * the owner reloading the page.
 */
describe("the ledger screen's tick (#295)", () => {
  beforeEach(() => {
    movements = [];
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await unmountAllMountedPages();
    document.body.innerHTML = "";
  });

  it("carries the ledger tick on the query, background flag included", async () => {
    // the wiring, not the runtime effect: happy-dom has no hidden tab, so the
    // behaviour itself is measured in the e2e (#295). Deleting the tick from
    // the page fails here; so does dropping the background flag.
    const page = await mountWithProviders(<ItemHistoryPage />);
    // the query (and with it the observer) exists from the first render; the
    // empty state is that first paint, so waiting for it is the liveness
    // signal — a fetch counter would only prove the call, not the page
    await page.poll(() => page.query("history-empty") !== null, "history-empty");
    const observer = page.queryClient.getQueryCache().find({ queryKey: ["itemsHistory"] })?.observers[0];
    expect(observer?.options.refetchInterval).toBe(LEDGER_REFETCH_MS);
    // a window that is visible but unfocused never sends a focus event, so
    // the tick only runs there because the flag says so
    expect(observer?.options.refetchIntervalInBackground).toBe(true);
  });

  it("refetches the ledger on the tick, so the running stock converges", async () => {
    // The FIRST read of the row says 6 units; a later read answers THE SAME
    // ROW with 5. What has to converge is the NUMBER ON SCREEN: a page that
    // ticks and keeps rendering the first read passes a fetch-count
    // assertion, and the `stock-after` cell is where the ledger renders
    // `movement.stockAfter`.
    //
    // The row keeps its id on purpose. A fixture that swapped in a row with a
    // NEW id would pass a page that renders a new row correctly but never
    // updates the row the owner is already looking at; with one id, the
    // assertion is about THAT row's cell moving.
    const row = movementRow();
    movements = [row];
    const page = await mountWithProviders(<ItemHistoryPage refreshMs={20} />);
    await page.poll(() => page.query("stock-after")?.textContent === "6", "first stock");
    // the next read answers THE SAME ROW with a different running balance: a
    // new object under the same id, so the query's data really changed and
    // React updates the row the owner is already looking at
    movements = [{ ...row, stockAfter: 5 }];
    await page.poll(() => page.query("stock-after")?.textContent === "5", "converged stock");
  });
});
