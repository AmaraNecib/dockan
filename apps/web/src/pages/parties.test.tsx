import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { PartyDetail, PartyListItem } from "@dokan/contracts";

import { PartiesPage } from "./parties";
import { PartyDetailPage } from "./party-detail";

type DetailRouteParams = { partyId?: string };

/** route params the detail page reads; switched per test */
let routeParams: DetailRouteParams = {};
const navigations: string[] = [];

// stub the router seam (Link as a plain anchor, params/navigate recorded)
mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: import("react").ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>{children}</a>;
  },
  useParams: () => routeParams,
  useNavigate: () => (target: { to: string }) => {
    navigations.push(target.to);
  },
}));

const EMPTY_STATS = { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 };

let customers: PartyListItem[] = [];
let suppliers: PartyListItem[] = [];
let details = new Map<string, PartyDetail>();
const deleted: string[] = [];
const updates: Array<{ id: string; name?: string; phone?: string | null }> = [];
const createdParties: Array<{ name: string; phone?: string }> = [];

const CUSTOMER_LIST_OPTIONS = () => ({ queryKey: ["customersList"], queryFn: async () => ({ items: customers }) });
const SUPPLIER_LIST_OPTIONS = () => ({ queryKey: ["suppliersList"], queryFn: async () => ({ items: suppliers }) });
const DETAIL_OPTIONS = ({ input }: { input: { id: string } }) => ({
  queryKey: ["partyDetail", input],
  queryFn: async () => {
    const found = details.get(input.id);
    if (found === undefined) throw new Error("PARTY_NOT_FOUND");
    return found;
  },
});

mock.module("@/lib/rpc", () => ({
  orpc: {
    customersList: { queryOptions: CUSTOMER_LIST_OPTIONS, queryKey: () => ["customersList"] },
    suppliersList: { queryOptions: SUPPLIER_LIST_OPTIONS, queryKey: () => ["suppliersList"] },
    customersGet: { queryOptions: DETAIL_OPTIONS },
    suppliersGet: { queryOptions: DETAIL_OPTIONS },
    customersCreate: {
      mutationOptions: () => ({
        mutationFn: async (input: { name: string; phone?: string }) => {
          createdParties.push(input);
          return { id: "new", name: input.name, phone: input.phone ?? null, createdAt: "" };
        },
      }),
    },
    suppliersCreate: {
      mutationOptions: () => ({
        mutationFn: async (input: { name: string; phone?: string }) => {
          createdParties.push(input);
          return { id: "new", name: input.name, phone: input.phone ?? null, createdAt: "" };
        },
      }),
    },
    customersUpdate: {
      mutationOptions: () => ({
        mutationFn: async (input: { id: string; name?: string; phone?: string | null }) => {
          updates.push(input);
          return { id: input.id, name: input.name ?? "", phone: input.phone ?? null, createdAt: "" };
        },
      }),
    },
    suppliersUpdate: { mutationOptions: () => ({ mutationFn: async () => ({ id: "s", name: "", phone: null, createdAt: "" }) }) },
    customersDelete: {
      mutationOptions: () => ({
        mutationFn: async (input: { id: string }) => {
          deleted.push(input.id);
          return { deleted: true };
        },
      }),
    },
    suppliersDelete: {
      mutationOptions: () => ({
        mutationFn: async (input: { id: string }) => {
          deleted.push(input.id);
          return { deleted: true };
        },
      }),
    },
  },
  rpcClient: {},
}));

const row = (over: Partial<PartyListItem> = {}): PartyListItem => ({
  id: "c-1",
  name: "علي علي",
  phone: "+213555123456",
  createdAt: "2026-10-01T10:00:00",
  stats: EMPTY_STATS,
  ...over,
});

const detail = (over: Partial<PartyDetail> = {}): PartyDetail => ({
  party: { id: "c-1", name: "علي علي", phone: "+213555123456", createdAt: "2026-10-01T10:00:00" },
  stats: EMPTY_STATS,
  invoices: [],
  payments: [],
  ...over,
});

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host, queryClient });
  return host;
}

/** The mocked query functions resolve a tick after mount; poll like siblings. */
async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  return false;
}

async function click(host: HTMLElement, selector: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`missing element ${selector}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setElementValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement; queryClient: QueryClient }> = [];

beforeEach(() => {
  customers = [];
  suppliers = [];
  details = new Map();
  deleted.length = 0;
  updates.length = 0;
  createdParties.length = 0;
  navigations.length = 0;
  routeParams = {};
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const { root, host, queryClient } of mounted.splice(0)) {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
  }
  document.body.innerHTML = "";
});

describe("PartiesPage (issue 120)", () => {
  it("renders the searched list with invoice count and remaining, and filters by name or phone", async () => {
    customers = [
      row(),
      row({ id: "c-2", name: "عماره", phone: null, stats: { ...EMPTY_STATS, invoiceCount: 3, remainingAmount: 12_000 } }),
    ];
    const host = await mount(<PartiesPage role="customer" />);
    await waitFor(() => host.querySelectorAll('[data-testid="party-row"]').length === 2);

    expect(host.querySelectorAll('[data-testid="party-row"]').length).toBe(2);
    const omarRow = Array.from(host.querySelectorAll<HTMLTableRowElement>('[data-testid="party-row"]')).find((r) => r.textContent?.includes("عماره"));
    expect(omarRow?.querySelector('[data-testid="party-row-count"]')?.textContent).toBe("3");
    expect(omarRow?.querySelector('[data-testid="party-row-remaining"]')?.textContent).toContain("12000");

    const search = host.querySelector<HTMLInputElement>('[data-testid="parties-search"]');
    await act(async () => {
      if (search !== null) setElementValue(search, "05551234");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelectorAll('[data-testid="party-row"]').length).toBe(1);
    expect(host.textContent).toContain("علي علي");
    expect(host.textContent).not.toContain("عماره");
  });

  it("creates a party from the dialog and reports it", async () => {
    const host = await mount(<PartiesPage role="customer" />);
    await click(host, '[data-testid="party-new"]');
    expect(host.querySelector('[data-testid="party-create-dialog"]')).not.toBeNull();

    const name = host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]');
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    await act(async () => {
      if (name !== null) setElementValue(name, "زبون جديد");
      if (phone !== null) setElementValue(phone, "0555111222");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await click(host, '[data-testid="party-form-save"]');

    expect(createdParties).toEqual([{ name: "زبون جديد", phone: "0555111222" }]);
    expect(host.querySelector('[data-testid="party-create-dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="parties-notice"]')).not.toBeNull();
  });

  it("edits a party from the row dialog", async () => {
    customers = [row()];
    const host = await mount(<PartiesPage role="customer" />);
    await waitFor(() => host.querySelectorAll('[data-testid="party-row"]').length === 1);

    await click(host, '[data-testid="party-row-edit"]');
    expect(host.querySelector('[data-testid="party-edit-dialog"]')).not.toBeNull();
    const name = host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]');
    await act(async () => {
      if (name !== null) setElementValue(name, "علي المعدّل");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await click(host, '[data-testid="party-form-save"]');
    // only the changed field is sent; the untouched phone is left alone (P1.2)
    expect(updates).toEqual([{ id: "c-1", name: "علي المعدّل" }]);
  });

  it("renders the supplier role through the supplier procedures", async () => {
    suppliers = [
      row({ id: "s-1", name: "مورد الاختبار", phone: null, stats: { ...EMPTY_STATS, invoiceCount: 1, remainingAmount: 1_200 } }),
      row({ id: "s-2", name: "مورد فارغ", phone: null }),
    ];
    const host = await mount(<PartiesPage role="supplier" />);
    await waitFor(() => host.querySelectorAll('[data-testid="party-row"]').length === 2);

    expect(host.querySelector('[data-testid="parties-page-supplier"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="party-role-supplier"]')?.getAttribute("aria-current")).toBe("page");
    expect(host.textContent).toContain("مورد الاختبار");
    expect(host.querySelector('[data-testid="party-row-remaining"]')?.textContent).toContain("1200");
    // the invoiced supplier keeps its delete disabled; the empty one deletes
    expect(host.querySelectorAll<HTMLButtonElement>('[data-testid="party-row-delete"]')[0]?.disabled).toBe(true);

    await click(host, '[data-testid="party-row-delete"]:not([disabled])');
    await click(host, '[data-testid="party-delete-confirm"]');
    expect(deleted).toEqual(["s-2"]);
  });

  it("disables delete for a party with invoices and deletes a zero-invoice one", async () => {
    customers = [
      row({ stats: { ...EMPTY_STATS, invoiceCount: 1, remainingAmount: 500 } }),
      row({ id: "c-2", name: "عماره", phone: null }),
    ];
    const host = await mount(<PartiesPage role="customer" />);
    await waitFor(() => host.querySelectorAll('[data-testid="party-row-delete"]').length === 2);

    const deleteButtons = host.querySelectorAll<HTMLButtonElement>('[data-testid="party-row-delete"]');
    expect(deleteButtons[0]?.disabled).toBe(true);
    expect(deleteButtons[1]?.disabled).toBe(false);

    await click(host, '[data-testid="party-row-delete"]:not([disabled])');
    expect(host.querySelector('[data-testid="party-delete-dialog"]')).not.toBeNull();
    await click(host, '[data-testid="party-delete-confirm"]');
    expect(deleted).toEqual(["c-2"]);
  });
});

describe("PartyDetailPage (issue 120)", () => {
  it("renders the header, stats strip and the three tabs", async () => {
    routeParams = { partyId: "c-1" };
    details.set(
      "c-1",
      detail({
        stats: { invoiceCount: 2, totalAmount: 2_700, paidAmount: 1_100, remainingAmount: 1_600 },
        invoices: [
          {
            id: "inv-4",
            invoiceNumber: "INV-0004",
            kind: "SALE",
            counterpartyId: "c-1",
            counterpartyName: "علي علي",
            invoiceDate: "2026-10-01",
            subtotalAmount: 2_300,
            discountType: null,
            discountValue: null,
            discountAmount: 0,
            totalAmount: 2_300,
            paidAmount: 700,
            remainingAmount: 1_600,
            notes: null,
            createdAt: "2026-10-01T10:00:00",
            updatedAt: "2026-10-01T10:00:00",
          },
        ],
        payments: [
          {
            id: "p-1",
            invoiceId: "inv-4",
            invoiceNumber: "INV-0004",
            amount: 700,
            method: "CASH",
            note: null,
            paidAt: "2026-10-01T10:05:00",
            createdAt: "2026-10-01T10:05:00",
          },
        ],
      }),
    );
    const host = await mount(<PartyDetailPage role="customer" />);
    await waitFor(() => host.querySelector('[data-testid="party-detail-name"]') !== null);

    expect(host.querySelector('[data-testid="party-detail-name"]')?.textContent).toBe("علي علي");
    expect(host.querySelector('[data-testid="party-stat-partyStatsRemaining"]')?.textContent).toContain("1600");
    expect(host.querySelectorAll('[data-testid="party-tab-invoices"], [data-testid="party-tab-payments"], [data-testid="party-tab-info"]').length).toBe(3);
    expect(host.querySelectorAll('[data-testid="party-invoice-row"]').length).toBe(1);
    expect(host.querySelector('[data-testid="party-invoice-row"]')?.textContent).toContain("مدفوعة جزئياً");
    // #119's day-first formatter is wired into the detail cells
    expect(host.querySelector('[data-testid="party-invoice-row"]')?.textContent).toContain("01/10/2026");
    expect(host.querySelector('[data-testid="party-created-at"]')?.textContent).toBe("01/10/2026 10:00");

    // the delete button is disabled while the party owns invoices
    const deleteButton = host.querySelector<HTMLButtonElement>('[data-testid="party-detail-delete"]');
    expect(deleteButton?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="party-delete-blocked-hint"]')).not.toBeNull();

    await click(host, '[data-testid="party-tab-payments"]');
    expect(host.querySelectorAll('[data-testid="party-payment-row"]').length).toBe(1);
    expect(host.querySelector('[data-testid="party-payment-row"]')?.textContent).toContain("INV-0004");
    expect(host.querySelector('[data-testid="party-payment-row"]')?.textContent).toContain("01/10/2026 10:05");
  });

  it("edits the party from the المعلومات tab", async () => {
    routeParams = { partyId: "c-1" };
    details.set("c-1", detail());
    const host = await mount(<PartyDetailPage role="customer" />);
    await waitFor(() => host.querySelector('[data-testid="party-form-name"]') !== null);

    await click(host, '[data-testid="party-detail-edit"]');
    expect(host.querySelector('[data-testid="party-panel-info"]')?.hasAttribute("hidden")).toBe(false);

    const name = host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]');
    await act(async () => {
      if (name !== null) setElementValue(name, "علي المعدّل");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await click(host, '[data-testid="party-form-save"]');

    expect(updates).toEqual([{ id: "c-1", name: "علي المعدّل" }]);
    expect(host.querySelector('[data-testid="party-detail-notice"]')).not.toBeNull();
  });

  it("deletes a zero-invoice party from the detail header", async () => {
    routeParams = { partyId: "c-1" };
    details.set("c-1", detail());
    const host = await mount(<PartyDetailPage role="customer" />);
    await waitFor(() => host.querySelector('[data-testid="party-detail-delete"]') !== null);

    await click(host, '[data-testid="party-detail-delete"]');
    await click(host, '[data-testid="party-delete-confirm"]');
    expect(deleted).toEqual(["c-1"]);
    expect(navigations).toEqual(["/customers"]);
  });

  it("shows the not-found state for an unknown party", async () => {
    routeParams = { partyId: "missing" };
    const host = await mount(<PartyDetailPage role="customer" />);
    await waitFor(() => host.querySelector('[data-testid="party-detail-error"]') !== null);
    expect(host.querySelector('[data-testid="party-detail-error"]')?.textContent).toContain("السجل غير موجود");
  });
});
