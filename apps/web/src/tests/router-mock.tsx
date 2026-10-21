import type { ReactNode } from "react";
import * as routerModule from "@tanstack/react-router";

/**
 * Shared `@tanstack/react-router` stub for the page unit tests.
 *
 * `Link` renders as a plain anchor carrying `to` + `params`, so a test can
 * assert the navigation target without mounting a RouterProvider. `useParams`
 * returns the caller-supplied route params (empty by default). One definition
 * keeps the four page tests from drifting apart.
 *
 * The real module is spread first: `mock.module` is process-global and leaks
 * across test files, so a page test that replaced the module wholesale would
 * break a sibling (app-sidebar) that needs `RouterProvider` (issue #94).
 *
 *   mock.module("@tanstack/react-router", routerMock);
 *   mock.module("@tanstack/react-router", () => routerMock({ invoiceId: "…" }));
 */
export function routerMock(params: Record<string, string> = {}) {
  return {
    ...routerModule,
    Link: (props: {
      children?: ReactNode;
      className?: string;
      "data-testid"?: string;
      params?: Record<string, string>;
      search?: boolean;
      to?: string;
    }) => {
      const { children, params: linkParams, search, to, ...rest } = props;
      // a router `search` flag has no DOM form; strip it so it is not spread
      // onto the anchor as an invalid attribute
      void search;
      return <a href={`${to ?? ""}?${new URLSearchParams(linkParams ?? {}).toString()}`} {...rest}>{children}</a>;
    },
    useParams: () => params,
    // PartyDetailPage navigates on delete; the stub keeps every page test from
    // needing to know about the router just to mount
    useNavigate: () => () => undefined,
    // The navigation blocker needs a live router to hold a navigation in; a
    // page test mounts a page, not a router, so the guard stays inert there
    // (#321). The real module is spread first, so this is the one hook that
    // has to be answered by hand.
    useBlocker: () => ({
      status: "idle" as const,
      current: undefined,
      next: undefined,
      action: undefined,
      proceed: undefined,
      reset: undefined,
    }),
  };
}

// #321 — why `apps/web` runs `bun test --isolate`: `mock.module` is process-global,
// so a leaked router mock swaps `useBlocker` for an inert stub and every guard test
// in the same process passes for the wrong reason. The flag isolates per FILE, not
// per test, so a leak inside one file (a history the back-button test pushes onto)
// is still shared by the tests after it in that file — keep per-file state honest.
