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
import { SupplierReturnPrintPage } from "./pages/supplier-return-print";
import { ReturnsPage } from "./pages/returns";
import { SettingsPage } from "./pages/settings";
import { DebtsPage } from "./pages/debts";
import { ExpensesPage } from "./pages/expenses";
import { PartiesPage } from "./pages/parties";
import { PartyDetailPage } from "./pages/party-detail";
import { SupplierOpeningBalancePage } from "./pages/supplier-opening-balance";
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

/** Role-pinned wrappers keep the route components stable across renders. */
function CustomersPage() {
  return <PartiesPage role="customer" />;
}
function SuppliersPage() {
  return <PartiesPage role="supplier" />;
}
function CustomerDetailRoutePage() {
  return <PartyDetailPage role="customer" />;
}
function SupplierDetailRoutePage() {
  return <PartyDetailPage role="supplier" />;
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
const customersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/customers", component: CustomersPage });
const customerDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/customers/$partyId", component: CustomerDetailRoutePage });
const suppliersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/suppliers", component: SuppliersPage });
// static route declared beside the dynamic detail route: TanStack ranks a static
// segment above `$partyId`, so /suppliers/opening-balance never hits the detail page
const supplierOpeningBalanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/suppliers/opening-balance", component: SupplierOpeningBalancePage });
const supplierDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/suppliers/$partyId", component: SupplierDetailRoutePage });
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
const supplierReturnVoucherRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/suppliers/$partyId/returns/$returnId/print",
  component: SupplierReturnPrintPage,
});
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
  customersRoute,
  customerDetailRoute,
  suppliersRoute,
  supplierOpeningBalanceRoute,
  supplierDetailRoute,
  invoicesRoute,
  invoiceRoute,
  invoicePrintRoute,
  returnVoucherPrintRoute,
  returnsRoute,
  supplierReturnVoucherRoute,
  expensesRoute,
  reportsRoute,
  settingsRoute,
  diagnosticsRoute,
]);

export const router = createRouter({ routeTree });
