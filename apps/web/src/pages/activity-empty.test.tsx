import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { DEFAULT_PAGE_SIZE } from "../lib/pagination";

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";

interface ActivityRow {
  id: string;
  at: string;
  type: string;
  summary: string;
  ref: string | null;
  actorId?: string | null;
  actorName?: string | null;
}

interface ActivityPageInput {
  limit: number;
  offset: number;
}

let rows: ActivityRow[] = [];
let activityRequests: ActivityPageInput[] = [];
let preferences: Record<string, string> = {};
let activityListError = false;

// NOTE: mock.module is process-global (see tests/router-mock.tsx); this file
// owns the whole @/lib/rpc seam for its duration.
mock.module("@/lib/rpc", () => ({
  orpc: {
    activitiesList: {
      queryOptions: ({ input }: { input: ActivityPageInput }) => ({
        queryKey: ["activitiesList", input],
        queryFn: async () => {
          activityRequests.push(input);
          if (activityListError) throw new Error("activity read failed");
          return { items: rows.slice(input.offset, input.offset + input.limit), total: rows.length };
        },
      }),
      queryKey: () => ["activitiesList"],
    },
  },
  rpcClient: {
    preferencesGet: async () => ({ values: { ...preferences } }),
    preferencesSet: async ({ key, value }: { key: string; value: string }) => {
      preferences[key] = value;
      return { key, value };
    },
  },
}));

const { ActivityLogPage } = await import("./activity");

describe("ActivityLogPage empty state (issue #96)", () => {
  beforeEach(() => {
    rows = [];
    activityRequests = [];
    preferences = {};
    activityListError = false;
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

  it("keeps the table accessible and shows saved actor names without UUIDs", async () => {
    const actorId = "4ec5f7d1-35b8-4c1c-985f-f78e9cc4cba9";
    rows = [
      { id: "a1", at: "2026-08-25T10:00:00", type: "SALE_CREATED", summary: "SALE_CREATED INV-1", ref: null, actorId, actorName: "مالك الاختبار" },
      { id: "a2", at: "2026-08-25T09:00:00", type: "BACKUP_CREATED", summary: "BACKUP_CREATED shop-backup.dknvbak", ref: null, actorId: null, actorName: null },
    ];
    const page = await mountWithProviders(<ActivityLogPage />);
    await page.poll(() => page.query("activity-table") !== null, "activity-table");

    const region = page.query("activity-table-region");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.querySelector("caption")?.textContent).toBe(i18n.t("activityTitle"));
    const headers = region?.querySelectorAll("thead th") ?? [];
    expect(headers).toHaveLength(5);
    expect([...headers].every((cell) => cell.getAttribute("scope") === "col")).toBe(true);
    expect(page.query("activity-actor")?.textContent).toContain("مالك الاختبار");
    expect(page.text()).toContain(i18n.t("activityActorUnknownSystem"));
    expect(page.text()).not.toContain(actorId);
  });

  it("sends the server page limit and offset and keeps the range in sync", async () => {
    const total = DEFAULT_PAGE_SIZE + 2;
    rows = Array.from({ length: total }, (_, index) => ({
      id: `a${index}`,
      at: `2026-08-25T10:${String(index).padStart(2, "0")}:00`,
      type: "SALE_CREATED",
      summary: `SALE_CREATED INV-${index}`,
      ref: null,
      actorId: null,
      actorName: null,
    }));
    const page = await mountWithProviders(<ActivityLogPage />);
    await page.poll(() => page.query("activity-table") !== null, "first activity page");
    await page.poll(() => activityRequests.some((request) => request.limit === DEFAULT_PAGE_SIZE && request.offset === 0), "initial server page input");

    expect(page.text()).toContain("INV-0");
    expect(page.text()).toContain(String(total));
    expect(page.query<HTMLButtonElement>("activity-pager-prev")?.disabled).toBe(true);
    expect(page.query<HTMLButtonElement>("activity-pager-next")?.disabled).toBe(false);

    await act(async () => page.query<HTMLButtonElement>("activity-pager-next")?.click());
    await page.poll(() => activityRequests.some((request) => request.limit === DEFAULT_PAGE_SIZE && request.offset === DEFAULT_PAGE_SIZE), "next server page input");
    await page.poll(() => page.text().includes(`INV-${DEFAULT_PAGE_SIZE}`), "next page rows");
    expect(page.query<HTMLButtonElement>("activity-pager-next")?.disabled).toBe(true);
    expect(page.query("activity-pager-range")?.textContent).toContain(String(total));

    await act(async () => page.query<HTMLButtonElement>("activity-pager-prev")?.click());
    await page.poll(() => activityRequests.some((request) => request.limit === DEFAULT_PAGE_SIZE && request.offset === 0), "previous server page input");
    await page.poll(() => page.text().includes("INV-0"), "first page rows after previous");

    await act(async () => page.query<HTMLButtonElement>("activity-pager-size-25")?.click());
    await page.poll(() => activityRequests.some((request) => request.limit === 25 && request.offset === 0), "changed page-size input");
    await page.poll(() => page.query("activity-pager") === null, "single-page pager hidden");
    expect(page.query("activity-table")?.querySelectorAll("tbody tr")).toHaveLength(total);
  });

  it("announces list failures and lets the owner retry", async () => {
    rows = [{ id: "a1", at: "2026-08-25T10:00:00", type: "SALE_CREATED", summary: "SALE_CREATED INV-1", ref: null }];
    activityListError = true;
    const page = await mountWithProviders(<ActivityLogPage />);
    await page.poll(() => page.container.querySelector('[role="alert"]') !== null, "activity error alert");
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("activityError"));

    activityListError = false;
    await act(async () => page.container.querySelector<HTMLButtonElement>("[role=alert] button")?.click());
    await page.poll(() => page.query("activity-table") !== null, "activity retry");
  });
});
