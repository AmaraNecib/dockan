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
  Wallet,
} from "lucide-react";

export type NavItem = {
  key: string;
  /** i18n key for the item label (existing nav* keys map onto Dokan's sections). */
  labelKey: string;
  to: string;
  icon: ComponentType<{ className?: string; size?: number }>;
};

export type NavGroup = {
  labelKey: string;
  /** true renders the group as a click-to-expand sub-group (the rare "System" cluster). */
  collapsible?: boolean;
  items: NavItem[];
};

/** Main sections stay flat; the rarely-used utilities collapse into one sub-group. */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "shellGroupMain",
    items: [
      { key: "dashboard", labelKey: "dashboardTitle", to: "/", icon: Gauge },
      { key: "categories", labelKey: "navCategories", to: "/categories", icon: Tags },
      { key: "items", labelKey: "navItems", to: "/items", icon: Package },
      { key: "purchase", labelKey: "navPurchases", to: "/purchase", icon: ShoppingCart },
      { key: "sale", labelKey: "navSales", to: "/sale", icon: ShoppingBag },
      { key: "invoices", labelKey: "navInvoices", to: "/invoices", icon: FileText },
      { key: "debts", labelKey: "navDebts", to: "/debts", icon: HandCoins },
      { key: "returns", labelKey: "navReturns", to: "/returns", icon: RotateCcw },
      { key: "expenses", labelKey: "navExpenses", to: "/expenses", icon: Wallet },
      { key: "reports", labelKey: "navReports", to: "/reports", icon: BarChart3 },
    ],
  },
  {
    labelKey: "shellGroupSystem",
    collapsible: true,
    items: [
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