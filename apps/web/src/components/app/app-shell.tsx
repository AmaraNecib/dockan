import { useRef, useState } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CircleHelp, LogOut, PanelLeft, ShoppingBag } from "lucide-react";

import { useSession, authClient } from "@/lib/auth-client";
import type { MessageKey } from "@/lib/i18n";
import { logoutAndReload } from "@/lib/logout";
import { usePendingReturnsCount } from "@/lib/pending-returns";
import { SLOW_REFETCH_MS } from "@/lib/freshness";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { focusInvoiceEntry } from "@/hooks/use-invoice-entry-shortcut";
import { shortcutKeys } from "@/lib/keyboard-actions";
import { Button } from "@/components/ui/button";
import { AppSidebar, type ShellUser } from "./app-sidebar";
import { DiscardDraftDialog } from "./discard-draft-dialog";
import { ThemeToggle } from "./theme-toggle";
import { ShortcutsHelp } from "./shortcuts-help";
import { LogoutDialog } from "./logout-dialog";
import { NAV_GROUPS, activeNavKey } from "./navigation";
import { useSaleDraft } from "./sale-draft";
import { useSidebarCollapsed } from "./sidebar-state";

function pageTitleFor(activeKey: string | null): MessageKey | null {
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
  const { draftDirtyRef, savePending, savePendingRef } = useSaleDraft();
  const [discardOpen, setDiscardOpen] = useState(false);

  function goToNewSale() {
    void navigate({
      to: "/sale",
      replace: activeKey === "sale",
      search: (prev: { fresh?: number }) => ({ ...prev, fresh: (prev.fresh ?? 0) + 1 }),
    });
  }

  function handleNewSale() {
    if (savePendingRef.current) return;
    if (draftDirtyRef.current) {
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
          if (savePendingRef.current) return;
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
  // the shared dialog (#321): the sale screen's question and its answers are
  // unchanged, only the markup moved
  return (
    <DiscardDraftDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={t("saleDiscardTitle")}
      description={t("saleDiscardDesc")}
      confirmLabel={t("saleDiscardConfirm")}
      cancelLabel={t("dialogClose")}
      confirmTestId="new-sale-discard-confirm"
    />
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const session = useSession();
  const user: ShellUser | null = session.data?.user
    ? { name: session.data.user.name ?? null, phone: session.data.user.phoneNumber ?? null }
    : null;

  const navigate = useNavigate();
  const { draftDirtyRef, savePendingRef } = useSaleDraft();
  const [purchaseDiscardOpen, setPurchaseDiscardOpen] = useState(false);
  const purchaseDiscardFocus = useRef<HTMLElement | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  // Server-side preference: survives a packaged restart (random localhost port
  // wipes localStorage). A failed read keeps the sidebar expanded.
  const { value: collapsed, updateValue: updateCollapsed, isPending: collapsedPending, isWriting: collapsedWriting } =
    useSidebarCollapsed();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeKey = activeNavKey(pathname);
  const activeTitleKey = pageTitleFor(activeKey);
  // issue #118 — one shared, polled aggregate keeps the «المرتجعات» badge in
  // step with the dashboard and a second window (round-2 findings 1 + 2).
  // #295 made the two stock counters hot and never named this badge, so it
  // keeps the bound it had: the calm one, not the counter tick.
  const pendingReturns = usePendingReturnsCount(SLOW_REFETCH_MS);

  function toggleSidebar() {
    updateCollapsed((current) => !current);
  }

  function closeTopmost() {
    if (logoutOpen) setLogoutOpen(false);
    else if (helpOpen) setHelpOpen(false);
  }

  function startSale() {
    if (savePendingRef.current) return;
    if (activeKey === "sale") focusInvoiceEntry("sale");
    else void navigate({ to: "/sale" });
  }

  function startPurchase() {
    if (savePendingRef.current) return;
    if (activeKey === "purchase") {
      focusInvoiceEntry("purchase");
      return;
    }
    if (activeKey === "sale" && draftDirtyRef.current) {
      purchaseDiscardFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPurchaseDiscardOpen(true);
      return;
    }
    void navigate({ to: "/purchase" });
  }

  useKeyboardShortcuts({
    onSale: startSale,
    onPurchase: startPurchase,
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
        pendingReturnsCount={pendingReturns.data?.count ?? null}
        pendingReturnsError={pendingReturns.isError}
        onExpand={() => updateCollapsed(() => false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="print-hidden flex h-14 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("sidebarToggle")}
            title={`${t("sidebarToggle")} (${shortcutKeys("onToggleSidebar")})`}
            onClick={toggleSidebar}
            disabled={collapsedPending || collapsedWriting}
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
              title={`${t("shortcutsTitle")} (${shortcutKeys("onHelp")})`}
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

      <DiscardDraftDialog
        title={t("saleToPurchaseDiscardTitle")}
        description={t("saleToPurchaseDiscardDesc")}
        confirmLabel={t("saleToPurchaseDiscardConfirm")}
        cancelLabel={t("dialogClose")}
        confirmTestId="new-sale-discard-confirm"
        finalFocus={() => purchaseDiscardFocus.current}
        open={purchaseDiscardOpen}
        onOpenChange={setPurchaseDiscardOpen}
        onConfirm={() => {
          if (savePendingRef.current) return;
          setPurchaseDiscardOpen(false);
          void navigate({ to: "/purchase" });
        }}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} onConfirm={() => { void logoutAndReload(() => authClient.signOut()); }} />
    </div>
  );
}