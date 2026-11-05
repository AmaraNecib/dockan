import { authLossRevision } from "./auth-refusal";
import { sessionRefreshGeneration } from "./session-refresh";

/** A binding never follows a replacement credential, even after recovery. */
export type CredentialLease = Readonly<{ isLive: () => boolean; assertLive: () => void }>;

export function createCredentialLease(): CredentialLease {
  const generation = sessionRefreshGeneration();
  const revision = authLossRevision();
  let retired = false;
  const isLive = (): boolean => {
    retired ||= generation !== sessionRefreshGeneration() || revision !== authLossRevision();
    return !retired;
  };
  return Object.freeze({
    isLive,
    assertLive: () => { if (!isLive()) throw new Error("SESSION_SCOPE_RETIRED"); },
  });
}
