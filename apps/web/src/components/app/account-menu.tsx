import { useEffect, useState } from "react";
import type { DokanClient } from "@dokan/contracts";

import { useRpc } from "@/lib/rpc-context";
import { useAuthLossReason } from "@/lib/auth-refusal";
import { sessionRefreshGeneration, useSessionRefreshGeneration } from "@/lib/session-refresh";

export type CurrentOwner = Awaited<ReturnType<DokanClient["currentOwner"]>>;

/** Mount-local identity, never a shared cache that could outlive an unlock. */
export function useCurrentOwner() {
  const { rpcClient } = useRpc();
  const loss = useAuthLossReason();
  const generation = useSessionRefreshGeneration();
  const [profileGeneration, setProfileGeneration] = useState(generation);
  const [profile, setProfile] = useState<CurrentOwner | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let alive = true;
    setProfile(null);
    setFailed(false);
    if (!loss) {
      void (async () => {
        try {
          const owner = await rpcClient.currentOwner();
          if (alive && generation === sessionRefreshGeneration()) {
            setProfileGeneration(generation);
            setProfile(owner);
          }
        } catch {
          if (alive) setFailed(true);
        }
      })();
    }
    return () => { alive = false; };
  }, [loss, attempt, generation, rpcClient]);
  return { profile: loss || profileGeneration !== generation ? null : profile, failed, blocked: Boolean(loss), retry: () => retry((value) => value + 1) };
}
