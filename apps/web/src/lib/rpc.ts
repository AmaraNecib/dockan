import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { DokanClient } from "@dokan/contracts";

import { readVaultSessionToken } from "./vault-client";

/**
 * The one RPC entry point. Same-origin through the vite /api proxy; cookies
 * ride along so the server-side session guard recognizes the login. In vault
 * mode the unlocked-owner session token rides a custom header (never a
 * cookie), so cross-origin pages cannot ride the unlock.
 */
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
      if (import.meta.env.MODE === "test") return;
      console.error("[dokan rpc]", error);
    }),
  ],
});

export const rpcClient: DokanClient = createORPCClient(rpcLink);
export const orpc = createTanstackQueryUtils(rpcClient);