import type { ComponentType } from "react";
import {
  Activity,
  BarChart3,
  FileText,
  Gauge,
  HandCoins,
  HardDriveDownload,
  Package,
  RotateCcw,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Stethoscope,
  Tags,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

export type NavItem = {
  key: string;
  /** i18n key for the item label (existing nav* keys map onto Dokan's sections). */
  labelKey: string;
  to: string;
  icon: ComponentType<{ className?: string; size?: number }>;
  /**
   * Keep the current search params on navigation. The sale route keys its form
   * remount on `fresh`, so dropping it from the sidebar link would silently reset
   * an in-progress sale.
   */
  preserveSearch?: boolean;
};

export type NavGroup = {
  labelKey: string;
  /** true renders the group as a click-to-expand sub-group (the rare "System" cluster). */
  collapsible?: boolean;
  items: NavItem[];
};

/** Primary group holds the daily sale→money workflow (sale/purchase/invoices/debts/
 * returns). The rarely-used catalog (categories, items) and back-office pages
 * (expenses, reports, backups, activity, diagnostics, settings) collapse into one
 * collapsible sub-group. Every page stays reachable; nothing is deleted. */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "shellGroupMain",
    items: [
      { key: "sale", labelKey: "navSales", to: "/sale", icon: ShoppingBag, preserveSearch: true },
      { key: "purchase", labelKey: "navPurchases", to: "/purchase", icon: ShoppingCart },
      { key: "invoices", labelKey: "navInvoices", to: "/invoices", icon: FileText },
      { key: "customers", labelKey: "navCustomers", to: "/customers", icon: Users },
      { key: "suppliers", labelKey: "navSuppliers", to: "/suppliers", icon: Truck },
      { key: "debts", labelKey: "navDebts", to: "/debts", icon: HandCoins },
      { key: "returns", labelKey: "navReturns", to: "/returns", icon: RotateCcw },
    ],
  },
  {
    labelKey: "shellGroupSystem",
    collapsible: true,
    items: [
      { key: "dashboard", labelKey: "dashboardTitle", to: "/", icon: Gauge },
      { key: "categories", labelKey: "navCategories", to: "/categories", icon: Tags },
      { key: "items", labelKey: "navItems", to: "/items", icon: Package },
      { key: "expenses", labelKey: "navExpenses", to: "/expenses", icon: Wallet },
      { key: "reports", labelKey: "navReports", to: "/reports", icon: BarChart3 },
      { key: "backups", labelKey: "navBackups", to: "/backups", icon: HardDriveDownload },
      { key: "activity", labelKey: "navActivity", to: "/activity", icon: Activity },
      { key: "diagnostics", labelKey: "navDiagnostics", to: "/diagnostics", icon: Stethoscope },
      { key: "settings", labelKey: "navSettings", to: "/settings", icon: Settings },
    ],
  },
];

/** Top-level slugs whose nav key equals their first pathname segment. */
const TOP_LEVEL = new Set([
  "categories",
  "items",
  "backups",
  "activity",
  "purchase",
  "sale",
  "customers",
  "suppliers",
  "debts",
  "invoices",
  "returns",
  "expenses",
  "reports",
  "settings",
  "diagnostics",
]);

/** Map a route pathname onto the nav key that should read "active". */
export function activeNavKey(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const head = segments[0] ?? "";

  // Exact top-level slugs first; nav key === first segment for all of these.
  if (TOP_LEVEL.has(head)) return head;
  if (pathname === "/" || pathname === "") return "dashboard";
  return null;
}