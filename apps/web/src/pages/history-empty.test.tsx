import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
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
