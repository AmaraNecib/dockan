import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { isAuthRefusal, markAuthLost } from "./auth-refusal";
import { createCredentialLease, type CredentialLease } from "./credential-lease";
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
export function createDokanRpcClient(lease: CredentialLease = createCredentialLease()): DokanClient {
  const rpcLink = new RPCLink({
    url: () => new URL("/api/rpc", window.location.origin).toString(),
    fetch: (request, init) => {
      // Encoding in StandardLink awaits. Check HERE, with no await between
      // validation, credential attachment and dispatch, not only at invocation.
      lease.assertLive();
      const headers = new Headers(request.headers);
      const vaultToken = readVaultSessionToken();
      if (vaultToken !== undefined) headers.set("x-vault-session", vaultToken);
      return globalThis.fetch(new Request(request, { headers }), {
        ...init,
        credentials: "include",
      });
    },
    interceptors: [
      async ({ next }) => {
        lease.assertLive();
        try {
          return await next();
        } catch (error) {
          // A refusal from a retired scope cannot close a freshly verified one.
          if (lease.isLive() && error instanceof ORPCError && isAuthRefusal(error)) markAuthLost();
          if (import.meta.env.MODE !== "test") console.error("[dokan rpc]", error);
          throw error;
        }
      },
    ],
  });
  return createORPCClient(rpcLink);
}
