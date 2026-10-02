import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChevronDown, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { NAV_GROUPS, type NavItem } from "./navigation";

export const SIDEBAR_EXPANDED_WIDTH = 240;
export const SIDEBAR_COLLAPSED_WIDTH = 64;

/** Items of the collapsible group (the "System" cluster); used to keep it open while it holds the active route. */
const COLLAPSIBLE_GROUP_ITEMS = NAV_GROUPS.find((group) => group.collapsible)?.items ?? [];

export type ShellUser = {
  name: string | null;
  phone: string | null;
};

/** A letter or two for the avatar, or null when there is nothing to show. */
function avatarText(user: ShellUser | null): string | null {
  const name = user?.name?.trim();
  if (!name) {
    const digits = user?.phone?.replace(/\D/g, "");
    return digits && digits.length > 0 ? digits.slice(0, 2) : null;
  }
  if (/[a-z]/i.test(name)) {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  }
  return name.slice(0, 2);
}

function displayName(user: ShellUser | null): string {
  return user?.name ?? user?.phone ?? "";
}

interface AppSidebarProps {
  collapsed: boolean;
  activeKey: string | null;
  user: ShellUser | null;
  /** pending-review return count for the «المرتجعات» badge (issue #118);
   * null is "not known yet", never a confirmed zero */
  pendingReturnsCount: number | null;
  /** true when the count read failed; the badge must read as unknown, not zero */
  pendingReturnsError: boolean;
  onExpand: () => void;
}

export function AppSidebar({ collapsed, activeKey, user, pendingReturnsCount, pendingReturnsError, onExpand }: AppSidebarProps) {
  const { t } = useTranslation();
  const systemHasActive = activeKey !== null && COLLAPSIBLE_GROUP_ITEMS.some((item) => item.key === activeKey);
  const [systemOpen, setSystemOpen] = useState(systemHasActive);

  // Never hide the current page's link (and aria-current) behind the collapsed
  // group: open it whenever the active route lives inside, including on load.
  useEffect(() => {
    if (systemHasActive) setSystemOpen(true);
  }, [activeKey, systemHasActive]);

  return (
    <aside
      className={cn(
        "border-e border-border bg-sidebar text-sidebar-foreground print-hidden flex flex-col overflow-hidden",
      )}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH }}
      aria-label={t("shellMainNav")}
    >
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground font-heading text-sm font-semibold italic">
          {t("appTitle").slice(0, 1)}
        </div>
        {!collapsed && (
          <span className="truncate font-heading text-base font-semibold">{t("appTitle")}</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2" aria-label={t("shellMainNav")}>
        {NAV_GROUPS.map((group) =>
          collapsed ? (
            <CollapsedGroup key={group.labelKey} activeKey={activeKey} items={group.items} pendingReturnsCount={pendingReturnsCount} pendingReturnsError={pendingReturnsError} />
          ) : (
            <div key={group.labelKey} className="mb-4">
              {group.collapsible ? (
                <>
                  <button
                    type="button"
                    onClick={() => setSystemOpen((o) => !o)}
                    aria-expanded={systemOpen}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground hover:bg-sidebar-accent hover:text-accent-foreground"
                  >
                    <span>{t(group.labelKey)}</span>
                    <ChevronDown size={14} className={cn("ms-auto transition-transform", !systemOpen && "-rotate-90")} />
                  </button>
                  {systemOpen && (
                    <div className="mt-0.5 space-y-1">
                      {group.items.map((item) => (
                        <NavLink
                          key={item.key}
                          item={item}
                          activeKey={activeKey}
                          badgeCount={item.key === "returns" ? pendingReturnsCount : 0}
                          badgeUnavailable={item.key === "returns" && pendingReturnsError}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="px-3 pb-1 pt-2 text-xs font-semibold tracking-wide text-muted-foreground">
                    {t(group.labelKey)}
                  </div>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.key}
                        item={item}
                        activeKey={activeKey}
                        badgeCount={item.key === "returns" ? pendingReturnsCount : 0}
                        badgeUnavailable={item.key === "returns" && pendingReturnsError}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          ),
        )}
      </nav>

      {/* User footer */}
      <div className="shrink-0 border-t border-border p-3">
        {collapsed ? (
          <button
            type="button"
            onClick={onExpand}
            title={displayName(user) || t("shellUser")}
            className="mx-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground text-xs font-semibold"
            aria-label={displayName(user) || t("shellUser")}
          >
            <AvatarGlyph user={user} />
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
              <AvatarGlyph user={user} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{displayName(user) || t("shellUser")}</div>
              {user?.phone ? (
                <div className="truncate text-xs text-muted-foreground">{user.phone}</div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function AvatarGlyph({ user }: { user: ShellUser | null }) {
  const text = avatarText(user);
  if (text === null) return <UserRound size={14} />;
  return <span dir="ltr">{text}</span>;
}

function CollapsedGroup({ items, activeKey, pendingReturnsCount, pendingReturnsError }: { items: NavItem[]; activeKey: string | null; pendingReturnsCount: number | null; pendingReturnsError: boolean }) {
  return (
    <div className="mb-1 space-y-0.5">
      {items.map((item) => (
        <NavLink
          key={item.key}
          item={item}
          activeKey={activeKey}
          collapsed
          badgeCount={item.key === "returns" ? pendingReturnsCount : 0}
          badgeUnavailable={item.key === "returns" && pendingReturnsError}
        />
      ))}
    </div>
  );
}

function NavLink({ item, activeKey, collapsed, badgeCount = null, badgeUnavailable = false }: { item: NavItem; activeKey: string | null; collapsed?: boolean; badgeCount?: number | null; badgeUnavailable?: boolean }) {
  const { t } = useTranslation();
  const active = activeKey === item.key;
  const Icon = item.icon;
  const label = t(item.labelKey);
  // a failed count is not a confirmed zero: label and draw it as unknown,
  // never as "nothing pending" (round-2 finding 1)
  const badgeLabel = badgeUnavailable
    ? t("returnsPendingBadgeUnavailable")
    : badgeCount !== null && badgeCount > 0
      ? t("returnsPendingBadgeLabel", { count: badgeCount })
      : null;
  const showBadge = badgeUnavailable || (badgeCount !== null && badgeCount > 0);
  return (
    <Link
      to={item.to}
      search={item.preserveSearch ? true : undefined}
      title={collapsed ? label : undefined}
      // `title` is a tooltip, not an accessible name: a collapsed icon-only
      // link must carry the label itself, and a badge state must be announced
      // rather than hidden behind an aria-hidden number.
      aria-label={badgeLabel === null ? (collapsed ? label : undefined) : `${label} — ${badgeLabel}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-md py-2 text-sm transition-colors select-none",
        collapsed ? "justify-center px-0" : "px-3",
        active ? "bg-sidebar-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-sidebar-accent hover:text-accent-foreground",
      )}
    >
      <Icon size={16} className={cn("shrink-0", active && "text-primary")} />
      {!collapsed && <span className="truncate">{label}</span>}
      {showBadge && (
        <span
          aria-hidden="true"
          className={cn(
            "grid place-items-center rounded-full border px-1.5 py-0.5 text-xs font-semibold",
            badgeUnavailable ? "border-warning/40 bg-warning/10 text-warning" : "border-transparent bg-primary text-primary-foreground",
            collapsed ? "absolute -end-1 -top-1" : "ms-auto",
          )}
          data-testid={badgeUnavailable ? "nav-returns-badge-unavailable" : "nav-returns-badge"}
        >
          {badgeUnavailable ? "!" : badgeCount}
        </span>
      )}
    </Link>
  );
}