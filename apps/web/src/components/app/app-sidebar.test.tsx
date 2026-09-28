import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../../lib/i18n";
import { AppSidebar } from "./app-sidebar";
import { NAV_GROUPS } from "./navigation";

// Sidebar collapse moved server-side (issue #97 follow-up). Mock the rpc seam
// before importing the module under test, like the other page tests do.
let preferenceStore: Record<string, string>;
let failPreferenceRead = false;
let failPreferenceWrite = false;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failPreferenceRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...preferenceStore } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (failPreferenceWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      preferenceStore[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const { SIDEBAR_COLLAPSED_KEY, migrateLegacySidebarCollapsed, readSidebarCollapsed, writeSidebarCollapsed } =
  await import("./sidebar-state");

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = "";
  window.localStorage.clear();
});

/**
 * AppSidebar renders router Links, so it needs a real (tiny) router context.
 * Every nav target gets a route so Link resolution never falls back to an
 * error; nothing else from the app graph is imported.
 */
async function mountSidebar(collapsed: boolean): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const rootRoute = createRootRoute({
    component: () => (
      <AppSidebar collapsed={collapsed} activeKey="sale" user={{ name: "مالك", phone: null }} onExpand={() => {}} />
    ),
  });
  const routes = NAV_GROUPS.flatMap((group) =>
    group.items.map((item) =>
      createRoute({ getParentRoute: () => rootRoute, path: item.to, component: () => null }),
    ),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/sale"] }),
  });
  mounted.push({ root, host });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => host.querySelector("a") !== null, "sidebar did not render any links");
  return host;
}

function linkFor(host: HTMLElement, path: string): HTMLAnchorElement | undefined {
  return Array.from(host.querySelectorAll("a")).find((anchor) => {
    const href = anchor.getAttribute("href");
    return href !== null && href.split("?")[0] === path;
  });
}

async function waitFor(check: () => boolean, failure: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(failure);
}

describe("sidebar collapse default (issue #94, server-side since #97)", () => {
  beforeEach(() => {
    preferenceStore = {};
    failPreferenceRead = false;
    failPreferenceWrite = false;
  });

  it("starts expanded when nothing is stored", async () => {
    expect(await readSidebarCollapsed()).toBe(false);
  });

  it("remembers an explicit collapse and an explicit expand", async () => {
    await writeSidebarCollapsed(true);
    expect(await readSidebarCollapsed()).toBe(true);
    await writeSidebarCollapsed(false);
    expect(await readSidebarCollapsed()).toBe(false);
  });

  it("falls back to expanded for a stale stored value", async () => {
    preferenceStore[SIDEBAR_COLLAPSED_KEY] = "legacy";
    expect(await readSidebarCollapsed()).toBe(false);
  });

  it("falls back to expanded when the preference read is unavailable", async () => {
    failPreferenceRead = true;
    expect(await readSidebarCollapsed()).toBe(false);
  });

  it("keeps the in-memory choice when the preference write fails", async () => {
    failPreferenceWrite = true;
    await expect(writeSidebarCollapsed(true)).resolves.toBe(false);
  });
});

describe("legacy sidebar preference migration (issue #97 follow-up)", () => {
  const LEGACY_KEY = "dokan.sidebar.collapsed";

  beforeEach(() => {
    preferenceStore = {};
    failPreferenceRead = false;
    failPreferenceWrite = false;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("imports the legacy collapse once and drops the legacy key", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    expect(await migrateLegacySidebarCollapsed()).toBe(true);
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("true");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("does not overwrite a server value and clears the stale legacy key", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    preferenceStore[SIDEBAR_COLLAPSED_KEY] = "false";
    expect(await migrateLegacySidebarCollapsed()).toBe(false);
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("false");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("keeps the legacy key when the write fails so the next launch retries", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    failPreferenceWrite = true;
    expect(await migrateLegacySidebarCollapsed()).toBe(false);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("true");
  });

  it("keeps the legacy key when the server read fails", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    failPreferenceRead = true;
    expect(await migrateLegacySidebarCollapsed()).toBe(false);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("true");
  });

  it("does not throw when localStorage is unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    try {
      await expect(migrateLegacySidebarCollapsed()).resolves.toBe(false);
    } finally {
      if (original !== undefined) Object.defineProperty(window, "localStorage", original);
    }
  });
});

describe("AppSidebar accessible names (issue #94)", () => {
  it("expanded: every nav link shows its Arabic label as text", async () => {
    const host = await mountSidebar(false);
    const mainGroup = NAV_GROUPS.find((group) => !group.collapsible);
    const systemGroup = NAV_GROUPS.find((group) => group.collapsible === true);
    expect(mainGroup).toBeDefined();
    expect(systemGroup).toBeDefined();
    for (const item of mainGroup?.items ?? []) {
      const link = linkFor(host, item.to);
      expect(link).toBeDefined();
      expect(link?.textContent).toContain(i18n.t(item.labelKey));
    }
    // The rare System cluster starts folded; open it and check its labels too.
    const toggle = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) =>
      button.textContent?.includes(i18n.t("shellGroupSystem")),
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle?.click();
    });
    for (const item of systemGroup?.items ?? []) {
      const link = linkFor(host, item.to);
      expect(link).toBeDefined();
      expect(link?.textContent).toContain(i18n.t(item.labelKey));
    }
  });

  it("collapsed: every nav link keeps an accessible name without visible text", async () => {
    const host = await mountSidebar(true);
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        const link = linkFor(host, item.to);
        expect(link).toBeDefined();
        expect(link?.getAttribute("aria-label")).toBe(i18n.t(item.labelKey));
        expect(link?.getAttribute("title")).toBe(i18n.t(item.labelKey));
      }
    }
    // icon-only: the label is not rendered as text, only as the accessible name
    const salesLink = linkFor(host, "/sale");
    expect(salesLink?.textContent).toBe("");
    expect(salesLink?.getAttribute("aria-current")).toBe("page");
  });
});
