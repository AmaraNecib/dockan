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
      to?: string;
    }) => {
      const { children, params: linkParams, to, ...rest } = props;
      return <a href={`${to ?? ""}?${new URLSearchParams(linkParams ?? {}).toString()}`} {...rest}>{children}</a>;
    },
    useParams: () => params,
    // PartyDetailPage navigates on delete; the stub keeps every page test from
    // needing to know about the router just to mount
    useNavigate: () => () => undefined,
  };
}
