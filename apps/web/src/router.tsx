import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

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
import { SettingsPage } from "./pages/settings";
import { DebtsPage } from "./pages/debts";
import { ExpensesPage } from "./pages/expenses";
import { ReportsPage } from "./pages/reports";
import "./lib/i18n";

const rootRoute = createRootRoute({
  component: () => {
    const { t } = useTranslation();
    return (
      <div className="min-h-screen bg-stone-100 text-stone-900">
        <header className="border-b bg-white print-hidden">
          <nav className="mx-auto flex max-w-3xl items-center gap-4 p-3">
            <Link to="/" className="font-bold">
              {t("appTitle")}
            </Link>
            <Link to="/categories" className="text-stone-600 hover:text-stone-900">
              {t("navCategories")}
            </Link>
            <Link to="/items" className="text-stone-600 hover:text-stone-900">
              {t("navItems")}
            </Link>
            <Link to="/backups" className="text-stone-600 hover:text-stone-900">
              {t("navBackups")}
            </Link>
            <Link to="/activity" className="text-stone-600 hover:text-stone-900">
              {t("navActivity")}
            </Link>
            <Link to="/purchase" className="text-stone-600 hover:text-stone-900">
              {t("navPurchases")}
            </Link>
            <Link to="/sale" className="text-stone-600 hover:text-stone-900">
              {t("navSales")}
            </Link>
            <Link to="/debts" className="text-stone-600 hover:text-stone-900">
              {t("navDebts")}
            </Link>
            <Link to="/invoices" className="text-stone-600 hover:text-stone-900">
              {t("navInvoices")}
            </Link>
            <Link to="/expenses" className="text-stone-600 hover:text-stone-900">
              {t("navExpenses")}
            </Link>
            <Link to="/reports" className="text-stone-600 hover:text-stone-900">
              {t("navReports")}
            </Link>
            <Link to="/settings" className="text-stone-600 hover:text-stone-900">
              {t("navSettings")}
            </Link>
            <Link to="/diagnostics" className="text-stone-600 hover:text-stone-900">
              {t("navDiagnostics")}
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl p-4">
          <Outlet />
        </main>
      </div>
    );
  },
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
const saleRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sale", component: SalePage });
const debtsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/debts", component: DebtsPage });
const invoicesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invoices", component: InvoicesPage });
const invoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invoices/$invoiceId", component: InvoicePage });
const invoicePrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices/$invoiceId/print",
  component: ReceiptPrintPage,
});
const expensesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/expenses", component: ExpensesPage });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reports", component: ReportsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const diagnosticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/diagnostics", component: DiagnosticsPage });

const routeTree = rootRoute.addChildren([
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
  expensesRoute,
  reportsRoute,
  settingsRoute,
  diagnosticsRoute,
]);

export const router = createRouter({ routeTree });
