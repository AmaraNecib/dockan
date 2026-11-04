import { createContext, useContext, type ReactNode } from "react";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { DokanClient } from "@dokan/contracts";
import { orpc, rpcClient } from "./rpc";
import type { CredentialLease } from "./credential-lease";

export type RpcBinding = {
  rpcClient: DokanClient;
  orpc: ReturnType<typeof createTanstackQueryUtils<DokanClient>>;
  lease?: CredentialLease;
};
const RpcContext = createContext<RpcBinding | null>(null);

export function RpcScopeProvider({ binding, children }: { binding: RpcBinding; children: ReactNode }) {
  return <RpcContext.Provider value={binding}>{children}</RpcContext.Provider>;
}

/** Capture during render, not when a retained async continuation resumes. */
export function useRpc(): RpcBinding {
  return useContext(RpcContext) ?? { rpcClient, orpc };
}
