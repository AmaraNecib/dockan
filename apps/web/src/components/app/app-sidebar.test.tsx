import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
let firstPreferenceWriteGate: Promise<void> | null = null;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failPreferenceRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...preferenceStore } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (failPreferenceWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      if (firstPreferenceWriteGate !== null) {
        const gate = firstPreferenceWriteGate;
        firstPreferenceWriteGate = null;
        await gate;
      }
      preferenceStore[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const { SIDEBAR_COLLAPSED_KEY, migrateLegacySidebarCollapsed, useSidebarCollapsed } =
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
async function mountSidebar(collapsed: boolean, pendingReturnsCount = 0): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const rootRoute = createRootRoute({
    component: () => (
      <AppSidebar
        collapsed={collapsed}
        activeKey="sale"
        user={{ name: "مالك", phone: null }}
        pendingReturnsCount={pendingReturnsCount}
        onExpand={() => {}}
      />
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

/** Minimal writer that exercises the real sidebar write path in the guard test. */
function SidebarWriter() {
  const { setValue } = useSidebarCollapsed();
  return (
    <button type="button" data-testid="sidebar-write" onClick={() => setValue(true)}>
      write
    </button>
  );
}

describe("legacy sidebar preference migration (issue #97 follow-up)", () => {
  const LEGACY_KEY = "dokan.sidebar.collapsed";

  beforeEach(() => {
    preferenceStore = {};
    failPreferenceRead = false;
    failPreferenceWrite = false;
    firstPreferenceWriteGate = null;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("imports the legacy collapse once and drops the legacy key", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    await migrateLegacySidebarCollapsed();
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("true");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("imports an explicit legacy expand as well", async () => {
    window.localStorage.setItem(LEGACY_KEY, "false");
    await migrateLegacySidebarCollapsed();
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("false");
  });

  it("does not overwrite a server value and clears the stale legacy key", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    preferenceStore[SIDEBAR_COLLAPSED_KEY] = "false";
    await migrateLegacySidebarCollapsed();
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("false");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("keeps the legacy key when the write fails so the next launch retries", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    failPreferenceWrite = true;
    await migrateLegacySidebarCollapsed();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("true");
  });

  it("keeps the legacy key when the server read fails", async () => {
    window.localStorage.setItem(LEGACY_KEY, "true");
    failPreferenceRead = true;
    await migrateLegacySidebarCollapsed();
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
      await expect(migrateLegacySidebarCollapsed()).resolves.toBeNull();
    } finally {
      if (original !== undefined) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("does not clobber a choice made while the migration read was in flight", async () => {
    let releaseWrite = () => {};
    firstPreferenceWriteGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SidebarWriter />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // the owner toggles; the write is held, so the server has no value yet
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='sidebar-write']")?.click());

    window.localStorage.setItem(LEGACY_KEY, "false");
    await migrateLegacySidebarCollapsed();
    // the migration skipped: nothing written and the legacy fallback is kept
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBeUndefined();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("false");

    releaseWrite();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("true");
    client.clear();
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

describe("AppSidebar pending-returns badge (issue #118)", () => {
  it("shows the pending count as a badge on the returns link", async () => {
    const host = await mountSidebar(false, 2);
    const badge = host.querySelector('[data-testid="nav-returns-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("2");
    // the badge rides the «المرتجعات» link, not another one
    expect(linkFor(host, "/returns")?.querySelector('[data-testid="nav-returns-badge"]')).not.toBeNull();
  });

  it("shows no badge when nothing is pending", async () => {
    const host = await mountSidebar(false, 0);
    expect(host.querySelector('[data-testid="nav-returns-badge"]')).toBeNull();
  });

  it("keeps the collapsed link's accessible name, count included", async () => {
    const host = await mountSidebar(true, 3);
    const returnsLink = linkFor(host, "/returns");
    expect(returnsLink?.getAttribute("aria-label")).toBe(
      `${i18n.t("navReturns")} — ${i18n.t("returnsPendingBadgeLabel", { count: 3 })}`,
    );
    expect(host.querySelector('[data-testid="nav-returns-badge"]')?.textContent).toBe("3");
  });
});
