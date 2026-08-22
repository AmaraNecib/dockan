import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { DokanClient } from "@dokan/contracts";

/**
 * The one RPC entry point. Same-origin through the vite /api proxy; cookies
 * ride along so the server-side session guard recognizes the login.
 */
const rpcLink = new RPCLink({
  url: () => new URL("/api/rpc", window.location.origin).toString(),
  fetch: (request, init) =>
    globalThis.fetch(request, {
      ...init,
      credentials: "include",
    }),
  interceptors: [
    onError((error) => {
      if (import.meta.env.MODE === "test") return;
      console.error("[dokan rpc]", error);
    }),
  ],
});

export const rpcClient: DokanClient = createORPCClient(rpcLink);
export const orpc = createTanstackQueryUtils(rpcClient);