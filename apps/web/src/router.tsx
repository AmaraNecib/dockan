import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { z } from "zod";

import { CategoriesPage } from "./pages/categories";
import { DashboardPage } from "./pages/dashboard";
import { ItemsPage } from "./pages/items";
import { ItemHistoryPage } from "./pages/stock";
import { BackupsPage } from "./pages/backups";
import { ActivityLogPage } from "./pages/activity";
import { DiagnosticsPage } from "./pages/diagnostics";
import { PurchasePage } from "./pages/purchase";
import { SalePage } from "./pages/sale";
import { InvoicesPage } from "./pages/invoices";
import { InvoicePage } from "./pages/invoice";
import { ReceiptPrintPage } from "./pages/receipt-print";
import { ReturnVoucherPrintPage } from "./pages/return-print";
import { ReturnsPage } from "./pages/returns";
import { SettingsPage } from "./pages/settings";
import { DebtsPage } from "./pages/debts";
import { ExpensesPage } from "./pages/expenses";
import { ReportsPage } from "./pages/reports";
import { AppShell } from "./components/app/app-shell";
import { SaleDraftProvider } from "./components/app/sale-draft";
import "./lib/i18n";

function RootShell() {
  return (
    <SaleDraftProvider>
      <AppShell />
    </SaleDraftProvider>
  );
}

const rootRoute = createRootRoute({
  component: RootShell,
});

const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const categoriesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/categories", component: CategoriesPage });
const itemsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/items", component: ItemsPage });
const itemHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/items/$itemId/history",
  component: ItemHistoryPage,
});
const backupsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/backups", component: BackupsPage });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityLogPage });
const purchaseRoute = createRoute({ getParentRoute: () => rootRoute, path: "/purchase", component: PurchasePage });
const saleSearchSchema = z.object({
  // The header action re-navigates to /sale with an incrementing `fresh` token.
  // Coercing keeps URL strings working; anything unparseable falls back to
  // undefined rather than throwing out of the route's search validation.
  fresh: z.coerce.number().int().nonnegative().optional().catch(undefined),
});

const saleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sale",
  // remountDeps remounts SalePage when `fresh` changes, so the header's New Sale
  // action starts a clean form (see the draft guard in app-shell's NewSaleAction).
  validateSearch: (search) => saleSearchSchema.parse(search),
  remountDeps: ({ search }) => search.fresh,
  component: SalePage,
});
const debtsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/debts", component: DebtsPage });
const invoicesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invoices", component: InvoicesPage });
const invoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invoices/$invoiceId", component: InvoicePage });
const invoicePrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices/$invoiceId/print",
  component: ReceiptPrintPage,
});
const returnVoucherPrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices/$invoiceId/returns/$returnId/print",
  component: ReturnVoucherPrintPage,
});
const returnsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/returns", component: ReturnsPage });
const expensesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/expenses", component: ExpensesPage });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reports", component: ReportsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const diagnosticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/diagnostics", component: DiagnosticsPage });

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  categoriesRoute,
  itemsRoute,
  itemHistoryRoute,
  backupsRoute,
  activityRoute,
  purchaseRoute,
  saleRoute,
  debtsRoute,
  invoicesRoute,
  invoiceRoute,
  invoicePrintRoute,
  returnVoucherPrintRoute,
  returnsRoute,
  expensesRoute,
  reportsRoute,
  settingsRoute,
  diagnosticsRoute,
]);

export const router = createRouter({ routeTree });
