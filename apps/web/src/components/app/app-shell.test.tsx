import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as routerModule from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import { ThemeProvider } from "@/lib/theme";
import { SLOW_REFETCH_MS } from "@/lib/freshness";

/**
 * #295 — the shell badge rides the CALM bound.
 *
 * `freshness.test.ts` pins the constants and `dashboard.test.tsx` pins the
 * dashboard's own call site, but the shell badge's interval lived only in a
 * comment: `usePendingReturnsCount(SLOW_REFETCH_MS)` -> `(HOT_COUNTER_REFETCH_MS)`
 * passed every test in the repo, and the badge would have started polling
 * twelve times faster than the contract says, in the surface every page
 * carries. The observer's own option is the assertion, because the observer is
 * what the browser's timer is built from.
 */

mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  // the shell is mounted on its own here: a router tree is not what this test
  // is about, and the real hooks throw outside one
  useRouterState: <T,>(opts?: { select?: (state: { location: { pathname: string } }) => T }) => {
    const state = { location: { pathname: "/" } };
    return opts?.select ? opts.select(state) : state;
  },
  useNavigate: () => () => undefined,
  Outlet: () => null,
  Link: (props: { children?: ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; search?: boolean; to?: string }) => {
    const { children, params, search, to, ...rest } = props;
    // the mock renders a plain anchor; a router `search` flag has no DOM form
    void search;
    return (
      <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>
        {children}
      </a>
    );
  },
}));

let pendingFetchCount = 0;
const defaultProfileRead = async () => ({ id: "owner-id", name: "عبد الرحمن Amara بن محمد صاحب المتجر ذو الاسم الطويل", phone: "+213550123123", role: "owner" as const });
let profileRead = defaultProfileRead;

mock.module("@/lib/rpc", () => ({
  orpc: {
    returnsPendingCount: {
      queryOptions: () => ({
        queryKey: ["returnsPendingCount"],
        queryFn: async () => {
          pendingFetchCount += 1;
          return { count: 0 };
        },
      }),
    },
  },
  // the sidebar's collapsed preference reads through the same seam
  rpcClient: {
    currentOwner: () => profileRead(),
    preferencesGet: async () => ({ values: {} }),
    preferencesSet: async (input: { key: string; value: string }) => input,
  },
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { name: "مالك", phoneNumber: "0550123123" } }, isPending: false }),
  authClient: { signOut: async () => undefined },
}));

const { AppShell } = await import("./app-shell");
const { SaleDraftProvider } = await import("./sale-draft");

async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (check()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return false;
}

describe("AppShell verified identity", () => {
  afterEach(async () => {
    profileRead = defaultProfileRead;
    const { clearAuthLost } = await import("@/lib/auth-refusal");
    await act(async () => clearAuthLost());
  });
  it("shows the verified mixed name and role without putting the phone in the header, and clears identity on auth loss", async () => {
    const { markAuthLost, clearAuthLost } = await import("@/lib/auth-refusal");
    clearAuthLost();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><ThemeProvider><SaleDraftProvider><AppShell /></SaleDraftProvider></ThemeProvider></QueryClientProvider>));
      expect(await waitFor(() => host.querySelector('[data-testid="account-menu-trigger"]') !== null)).toBe(true);
      const header = host.querySelector("header");
      if (!header) throw new Error("shell header missing");
      expect(header.textContent).toContain("عبد الرحمن Amara بن محمد");
      expect(header.textContent).toContain("المالك");
      expect(header.textContent).not.toContain("+213550123123");
      await act(async () => markAuthLost());
      expect(header.textContent).not.toContain("عبد الرحمن");
      expect(host.querySelector('[data-testid="account-menu-trigger"]')).toBeNull();
      expect(header.textContent).not.toContain("جارٍ تحميل الحساب");
      expect(header.textContent).toContain("الحساب غير متاح.");
      expect(header.textContent).not.toContain("أعد المحاولة");
      profileRead = async () => { throw new Error("network unavailable"); };
      await act(async () => clearAuthLost());
      expect(await waitFor(() => header.textContent?.includes("تعذّر تحميل الحساب") === true)).toBe(true);
      expect(header.textContent).not.toContain("المالك");

      let resolveOld = (_owner: Awaited<ReturnType<typeof defaultProfileRead>>) => {};
      let resolveNew = (_owner: Awaited<ReturnType<typeof defaultProfileRead>>) => {};
      const oldRead = new Promise<Awaited<ReturnType<typeof defaultProfileRead>>>((resolve) => { resolveOld = resolve; });
      const newRead = new Promise<Awaited<ReturnType<typeof defaultProfileRead>>>((resolve) => { resolveNew = resolve; });
      let reads = 0;
      profileRead = () => { reads += 1; return reads === 1 ? oldRead : newRead; };
      const retry = header.querySelector("button[title='تعذّر تحميل الحساب. أعد المحاولة.']");
      if (!(retry instanceof HTMLButtonElement)) throw new Error("account retry missing");
      await act(async () => retry.click());
      expect(reads).toBe(1);
      await act(async () => markAuthLost());
      await act(async () => clearAuthLost());
      expect(reads).toBe(2);
      const owner = await defaultProfileRead();
      await act(async () => resolveNew({ ...owner, name: "المالك الجديد" }));
      expect(header.textContent).toContain("المالك الجديد");
      await act(async () => resolveOld({ ...owner, name: "المالك السابق" }));
      expect(header.textContent).toContain("المالك الجديد");
      expect(header.textContent).not.toContain("المالك السابق");
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      host.remove();
      profileRead = defaultProfileRead;
    }
  });
});

describe("AppShell pending-returns badge (#295)", () => {
  let queryClient: QueryClient;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    queryClient.clear();
    host?.remove();
    host = null;
    document.body.innerHTML = "";
  });

  it("asks the shared count for the calm bound, not the hot counter tick", async () => {
    pendingFetchCount = 0;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SaleDraftProvider>
              <AppShell />
            </SaleDraftProvider>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    // the badge read has to be mounted before there is an observer to inspect
    expect(await waitFor(() => pendingFetchCount >= 1)).toBe(true);
    const observer = queryClient.getQueryCache().find({ queryKey: ["returnsPendingCount"] })?.observers[0];
    expect(observer?.options.refetchInterval).toBe(SLOW_REFETCH_MS);
    // and the flag that keeps a hidden window's badge current
    expect(observer?.options.refetchIntervalInBackground).toBe(true);

    await act(async () => root.unmount());
  });
});
