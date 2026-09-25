import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CircleHelp, LogOut, PanelLeft, ShoppingBag } from "lucide-react";

import { useSession, authClient } from "@/lib/auth-client";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Button } from "@/components/ui/button";
import { AppSidebar, type ShellUser } from "./app-sidebar";
import { ThemeToggle } from "./theme-toggle";
import { ShortcutsHelp } from "./shortcuts-help";
import { LogoutDialog } from "./logout-dialog";
import { NAV_GROUPS, activeNavKey } from "./navigation";

const SIDEBAR_KEY = "dokan.sidebar.collapsed";

function readSidebarDefault(): boolean {
  try {
    const value = window.localStorage.getItem(SIDEBAR_KEY);
    return value !== "false"; // collapsed when unset or stale
  } catch {
    return true;
  }
}

function pageTitleFor(activeKey: string | null): string | null {
  if (!activeKey) return null;
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.key === activeKey);
    if (item) return item.labelKey;
  }
  return null;
}

export function AppShell() {
  const { t } = useTranslation();
  const session = useSession();
  const user: ShellUser | null = session.data?.user
    ? { name: session.data.user.name ?? null, phone: session.data.user.phoneNumber ?? null }
    : null;

  const [collapsed, setCollapsed] = useState(readSidebarDefault);
  const [helpOpen, setHelpOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeKey = activeNavKey(pathname);
  const activeTitleKey = pageTitleFor(activeKey);

  function toggleSidebar() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  function closeTopmost() {
    if (logoutOpen) setLogoutOpen(false);
    else if (helpOpen) setHelpOpen(false);
  }

  useKeyboardShortcuts({
    onToggleSidebar: toggleSidebar,
    onHelp: () => setHelpOpen(true),
    onClose: closeTopmost,
  });

  return (
    <div dir="rtl" className="flex h-screen overflow-hidden bg-background text-foreground print:h-auto print:overflow-visible">
      <AppSidebar
        collapsed={collapsed}
        activeKey={activeKey}
        user={user}
        onExpand={() => setCollapsed(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="print-hidden flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("sidebarToggle")}
            title={t("sidebarToggle")}
            onClick={toggleSidebar}
          >
            <PanelLeft size={18} />
          </Button>

          <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium">
            {activeTitleKey ? t(activeTitleKey) : t("appTitle")}
          </div>

          <Button
            asChild
            data-testid="new-sale-button"
            className="gap-1.5"
          >
            <Link to="/sale">
              <ShoppingBag size={18} />
              <span>{t("saleNew")}</span>
            </Link>
          </Button>

          <div className="flex items-center gap-1">
            <ThemeToggle />

            <Button
              variant="ghost"
              size="icon"
              aria-label={t("shortcutsTitle")}
              title={t("shortcutsTitle")}
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={18} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              aria-label={t("logout")}
              title={t("logout")}
              onClick={() => setLogoutOpen(true)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut size={18} />
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto print:overflow-visible">
          <div className="mx-auto w-full max-w-7xl px-6 py-6" style={{ minHeight: 0 }}>
            <Outlet />
          </div>
        </main>
      </div>

      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} onConfirm={() => { void authClient.signOut().finally(() => window.location.reload()); }} />
    </div>
  );
}