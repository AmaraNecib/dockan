import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DokanClient } from "@dokan/contracts";
import { ChevronDown } from "lucide-react";

import { useRpc } from "@/lib/rpc-context";
import { useAuthLossReason } from "@/lib/auth-refusal";
import { sessionRefreshGeneration, useSessionRefreshGeneration } from "@/lib/session-refresh";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel } from "@/components/ui/dropdown-menu";

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

export function AccountMenu({ profile, failed, blocked, retry, onLogout }: {
  profile: CurrentOwner | null;
  failed: boolean;
  blocked: boolean;
  retry: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  if (!profile) {
    if (blocked) return <span role="status" className="max-w-40 text-xs text-muted-foreground">{t("accountBlocked")}</span>;
    return failed ? (
      <button type="button" onClick={retry} className="max-w-40 text-xs text-destructive" title={t("accountUnavailable")}>
        {t("accountUnavailable")}
      </button>
    ) : <span role="status" className="text-xs text-muted-foreground">{t("accountLoading")}</span>;
  }
  return (
    <Menu>
      <MenuTrigger
        data-testid="account-menu-trigger"
        className="flex min-w-0 max-w-48 shrink items-center gap-1 rounded-md px-2 py-1 text-start outline-offset-2 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="min-w-0">
          <bdi className="block truncate text-sm font-medium" title={profile.name}>{profile.name}</bdi>
          <span className="block text-xs text-muted-foreground">{t("accountOwner")}</span>
        </span>
        <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" dir="rtl" className="max-w-[min(24rem,calc(100vw-2rem))]">
        <MenuGroup>
          <MenuGroupLabel>
            <bdi className="block break-words text-foreground">{profile.name}</bdi>
            <span className="block">{t("accountOwner")}</span>
            {profile.phone && <bdi dir="ltr" className="block text-end" data-testid="account-phone">{profile.phone}</bdi>}
          </MenuGroupLabel>
          <MenuItem onClick={onLogout}>{t("logout")}</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
