import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CategoriesPage } from "./pages/categories";
import { DashboardPage } from "./pages/dashboard";
import { ItemsPage } from "./pages/items";
import { ItemHistoryPage } from "./pages/stock";
import { BackupsPage } from "./pages/backups";
import { ActivityLogPage } from "./pages/activity";
import { PurchasePage } from "./pages/purchase";
import { SalePage } from "./pages/sale";
import "./lib/i18n";

const rootRoute = createRootRoute({
  component: () => {
    const { t } = useTranslation();
    return (
      <div className="min-h-screen bg-stone-100 text-stone-900">
        <header className="border-b bg-white">
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

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  categoriesRoute,
  itemsRoute,
  itemHistoryRoute,
  backupsRoute,
  activityRoute,
  purchaseRoute,
  saleRoute,
]);

export const router = createRouter({ routeTree });