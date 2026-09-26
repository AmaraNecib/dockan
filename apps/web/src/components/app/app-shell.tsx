import { useState } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CircleHelp, LogOut, PanelLeft, ShoppingBag } from "lucide-react";

import { useSession, authClient } from "@/lib/auth-client";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppSidebar, type ShellUser } from "./app-sidebar";
import { ThemeToggle } from "./theme-toggle";
import { ShortcutsHelp } from "./shortcuts-help";
import { LogoutDialog } from "./logout-dialog";
import { NAV_GROUPS, activeNavKey } from "./navigation";
import { useSaleDraft } from "./sale-draft";

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

interface NewSaleActionProps {
  activeKey: string | null;
}

/**
 * The header's persistent "New Sale" action. It starts a fresh sale by bumping
 * the route's `fresh` token (see the sale route's remountDeps), but never at the
 * cost of live work: it is disabled while a save is in flight, and it asks first
 * when the form holds an unsaved draft.
 */
function NewSaleAction({ activeKey }: NewSaleActionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { draftDirty, savePending } = useSaleDraft();
  const [discardOpen, setDiscardOpen] = useState(false);

  function goToNewSale() {
    void navigate({
      to: "/sale",
      replace: activeKey === "sale",
      search: (prev: { fresh?: number }) => ({ ...prev, fresh: (prev.fresh ?? 0) + 1 }),
    });
  }

  function handleNewSale() {
    if (savePending) return;
    if (draftDirty) {
      setDiscardOpen(true);
      return;
    }
    goToNewSale();
  }

  return (
    <>
      <Button
        data-testid="new-sale-button"
        aria-label={t("saleNew")}
        className="gap-1.5"
        onClick={handleNewSale}
        disabled={savePending}
      >
        <ShoppingBag size={18} />
        <span className="hidden sm:inline">{t("saleNew")}</span>
      </Button>
      <DiscardSaleDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        onConfirm={() => {
          setDiscardOpen(false);
          goToNewSale();
        }}
      />
    </>
  );
}

interface DiscardSaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function DiscardSaleDialog({ open, onOpenChange, onConfirm }: DiscardSaleDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("saleDiscardTitle")}</DialogTitle>
          <DialogDescription>{t("saleDiscardDesc")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("dialogClose")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid="new-sale-discard-confirm">
            {t("saleDiscardConfirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
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

          <NewSaleAction activeKey={activeKey} />

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