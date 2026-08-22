import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { CategoriesPage } from "./pages/categories";
import { DashboardPage } from "./pages/dashboard";
import { ItemsPage } from "./pages/items";
import { strings } from "./lib/strings";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-stone-100 text-stone-900">
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-3xl items-center gap-4 p-3">
          <Link to="/" className="font-bold">
            {strings.appTitle}
          </Link>
          <Link to="/categories" className="text-stone-600 hover:text-stone-900">
            {strings.nav.categories}
          </Link>
          <Link to="/items" className="text-stone-600 hover:text-stone-900">
            {strings.nav.items}
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl p-4">
        <Outlet />
      </main>
    </div>
  ),
});

const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const categoriesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/categories", component: CategoriesPage });
const itemsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/items", component: ItemsPage });

const routeTree = rootRoute.addChildren([dashboardRoute, categoriesRoute, itemsRoute]);

export const router = createRouter({ routeTree });