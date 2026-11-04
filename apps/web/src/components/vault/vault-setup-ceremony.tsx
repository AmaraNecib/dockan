import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { VaultCleanupOutcome } from "@/lib/vault-client";

export type VaultSetupCeremony = {
  attempt?: symbol;
  pending?: boolean;
  failure?: string;
  recoveryKey: string | null;
  cleanup: VaultCleanupOutcome | undefined;
  savedConfirmed: boolean;
};
const emptyCeremony: VaultSetupCeremony = { recoveryKey: null, cleanup: undefined, savedConfirmed: false };
type CeremonyState = [VaultSetupCeremony, Dispatch<SetStateAction<VaultSetupCeremony>>];
const CeremonyContext = createContext<CeremonyState | null>(null);

/** Memory only, above the credential tree that advisory verification replaces. */
export function VaultSetupCeremonyProvider({ children }: { children: ReactNode }) {
  const state = useState(emptyCeremony);
  return <CeremonyContext.Provider value={state}>{children}</CeremonyContext.Provider>;
}

export function useVaultSetupCeremony(): CeremonyState {
  const local = useState(emptyCeremony);
  return useContext(CeremonyContext) ?? local;
}
