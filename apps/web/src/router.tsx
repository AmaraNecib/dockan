import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CategoriesPage } from "./pages/categories";
import { DashboardPage } from "./pages/dashboard";
import { ItemsPage } from "./pages/items";
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

const routeTree = rootRoute.addChildren([dashboardRoute, categoriesRoute, itemsRoute]);

export const router = createRouter({ routeTree });