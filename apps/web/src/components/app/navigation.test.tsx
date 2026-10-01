import { describe, expect, it } from "bun:test";

import { NAV_GROUPS, activeNavKey } from "./navigation";

describe("navigation information architecture", () => {
  it("keeps the daily sale→money workflow as the primary group, sale first", () => {
    const primary = NAV_GROUPS.find((group) => group.labelKey === "shellGroupMain");
    expect(primary).toBeDefined();
    expect(primary?.collapsible).toBeFalsy();
    expect(primary?.items.map((item) => item.key)).toEqual([
      "sale",
      "purchase",
      "invoices",
      "customers",
      "suppliers",
      "debts",
      "returns",
    ]);
    expect(primary?.items.map((item) => item.to)).toEqual([
      "/sale",
      "/purchase",
      "/invoices",
      "/customers",
      "/suppliers",
      "/debts",
      "/returns",
    ]);
  });

  it("keeps catalog and back-office routes in the collapsible System group", () => {
    const system = NAV_GROUPS.find((group) => group.collapsible === true);
    expect(system).toBeDefined();
    expect(system?.labelKey).toBe("shellGroupSystem");
    expect(system?.items.map((item) => item.key)).toEqual([
      "dashboard",
      "categories",
      "items",
      "expenses",
      "reports",
      "backups",
      "activity",
      "diagnostics",
      "settings",
    ]);
  });

  it("lists every page exactly once and maps its route to its nav key", () => {
    const items = NAV_GROUPS.flatMap((group) => group.items);
    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items).toHaveLength(16);
    for (const item of items) {
      expect(activeNavKey(item.to)).toBe(item.key);
    }
  });
});
