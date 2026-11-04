import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createDokanRpcClient } from "./rpc-link";
import { createCredentialLease } from "./credential-lease";

/** One immutable lease owns both direct RPC calls and generated query functions. */
export function createRpcBinding() {
  const lease = createCredentialLease();
  const rpcClient = createDokanRpcClient(lease);
  return { lease, rpcClient, orpc: createTanstackQueryUtils(rpcClient) };
}
