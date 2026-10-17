import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";

interface ActivityRow {
  id: string;
  at: string;
  type: string;
  summary: string;
  ref: string | null;
}

let rows: ActivityRow[] = [];

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration.
mock.module("@/lib/rpc", () => ({
  orpc: {
    activitiesList: {
      queryOptions: () => ({
        queryKey: ["activitiesList"],
        queryFn: async () => ({ items: rows, total: rows.length }),
      }),
      queryKey: () => ["activitiesList"],
    },
  },
  rpcClient: {},
}));

const { ActivityLogPage } = await import("./activity");

describe("ActivityLogPage empty state (issue #96)", () => {
  beforeEach(() => {
    rows = [];
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await unmountAllMountedPages();
    document.body.innerHTML = "";
  });

  it("explains what fills a read-only log instead of faking an action", async () => {
    const page = await mountWithProviders(<ActivityLogPage />);
    await page.poll(() => page.query("activity-empty") !== null, "activity-empty");

    const empty = page.query("activity-empty");
    expect(empty?.textContent).toContain(i18n.t("activityEmpty"));
    expect(empty?.textContent).toContain(i18n.t("activityEmptyHint"));
    // the acceptance rule for a read-only list: no invented pressable step
    expect(empty?.querySelector("button, a")).toBeNull();
    expect(page.query("activity-table")).toBeNull();
  });

  it("does not show the empty state once a movement exists", async () => {
    rows = [{ id: "a1", at: "2026-08-25T10:00:00", type: "SALE_CREATED", summary: "SALE_CREATED INV-1", ref: null }];
    const page = await mountWithProviders(<ActivityLogPage />);
    await page.poll(() => page.query("activity-table") !== null, "activity-table");

    expect(page.query("activity-empty")).toBeNull();
  });
});
