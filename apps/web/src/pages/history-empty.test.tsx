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
/** counts the ledger reads, so the tick is observable */
let historyFetches = 0;

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration.
mock.module("@/lib/rpc", () => ({
  orpc: {
    itemsHistory: {
      queryOptions: () => ({
        queryKey: ["itemsHistory"],
        queryFn: async () => {
          historyFetches += 1;
          return { movements, total: movements.length };
        },
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
    historyFetches = 0;
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
    historyFetches = 0;
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
    await page.poll(() => historyFetches >= 1, "history fetch");
    const observer = page.queryClient.getQueryCache().find({ queryKey: ["itemsHistory"] })?.observers[0];
    expect(observer?.options.refetchInterval).toBe(LEDGER_REFETCH_MS);
    // a window that is visible but unfocused never sends a focus event, so
    // the tick only runs there because the flag says so
    expect(observer?.options.refetchIntervalInBackground).toBe(true);
  });

  it("refetches the ledger on the tick, so the running stock converges", async () => {
    const page = await mountWithProviders(<ItemHistoryPage refreshMs={20} />);
    await page.poll(() => historyFetches >= 2, "history refetch");
  });
});
