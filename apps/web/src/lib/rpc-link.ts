import { createORPCClient, onError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { isAuthRefusal, markAuthLost } from "./auth-refusal";
import { readVaultSessionToken } from "./vault-client";

/**
 * The one RPC link, and the refusal interceptor that hangs off it.
 *
 * Same-origin through the vite /api proxy; cookies ride along so the
 * server-side session guard recognizes the login. In vault mode the
 * unlocked-owner session rides the transport the API's mode picked (issue
 * #319): the browser path's credential is an `HttpOnly` cookie this page never
 * sees, and the broker path's token rides the `x-vault-session` header,
 * because there the secret crosses the native bridge by design.
 *
 * The construction lives here rather than in `rpc.ts` so it can be tested: a
 * component test that mocks `@/lib/rpc` shadows the whole module for the rest
 * of the process, which left the interceptor below impossible to reach from
 * any other test file. `rpc-link.test.ts` builds a client from this factory
 * and drives a real oRPC refusal through it.
 */
export function createDokanRpcClient(): DokanClient {
  const rpcLink = new RPCLink({
    url: () => new URL("/api/rpc", window.location.origin).toString(),
    fetch: (request, init) => {
      const headers = new Headers(request.headers);
      const vaultToken = readVaultSessionToken();
      if (vaultToken !== undefined) headers.set("x-vault-session", vaultToken);
      return globalThis.fetch(new Request(request, { headers }), {
        ...init,
        credentials: "include",
      });
    },
    interceptors: [
      onError((error) => {
        // the session can die under a live window: the refusal means the unlock
        // screen, not a page of failed queries (#319). The shape check is the
        // I/O boundary's job; `isAuthRefusal` only decides what the code MEANS.
        if (error instanceof ORPCError && isAuthRefusal(error)) markAuthLost();
        if (import.meta.env.MODE === "test") return;
        console.error("[dokan rpc]", error);
      }),
    ],
  });
  return createORPCClient(rpcLink);
}
