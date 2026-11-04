import { createContext, useContext, type ReactNode } from "react";

const SessionCacheScopeContext = createContext<string | null>(null);

export function SessionCacheScopeProvider({ scopeId, children }: { scopeId: string; children: ReactNode }) {
  return <SessionCacheScopeContext.Provider value={scopeId}>{children}</SessionCacheScopeContext.Provider>;
}

export function useSessionCacheScope(): string {
  const scopeId = useContext(SessionCacheScopeContext);
  if (scopeId === null) throw new Error("SessionCacheScopeProvider is missing");
  return scopeId;
}
