import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { DokanClient } from "@dokan/contracts";

import { createDokanRpcClient } from "./rpc-link";

/**
 * The one RPC entry point every screen imports.
 *
 * The link itself — the URL, the credential transport, and the refusal
 * interceptor that raises the unlock screen (#319) — is built by
 * `createDokanRpcClient` in `./rpc-link`, so the interceptor is testable from a
 * file that does not have to mock this module. Component tests mock THIS file
 * (`@/lib/rpc`), and bun's module mock shadows the real one for the rest of the
 * process, which is why the refusal wiring must not live here.
 */
export const rpcClient: DokanClient = createDokanRpcClient();
export const orpc = createTanstackQueryUtils(rpcClient);
