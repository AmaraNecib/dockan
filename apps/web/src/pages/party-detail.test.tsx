import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n";

import type { Invoice, PartyDetail } from "@dokan/contracts";

import { routerMock } from "../tests/router-mock";

const PARTY_ID = "00000000-0000-4000-8000-0000000000aa";

/** every invoicesPay input the settle panel sent, in call order */
let payInputs: Array<{ invoiceId: string; amount: number; method?: string }> = [];
/** when > 0, the Nth invoicesPay call rejects (mid-loop failure) */
let failPayAt = 0;
let payCalls = 0;
/** a gate held over the customersGet REFETCH, to widen the post-payment window */
let detailCalls = 0;
/** #174 — the invoices tab served from the paginated read */
let invoiceTabCalls = 0;
let detailGate: Promise<void> | null = null;
let releaseDetailGate: (() => void) | null = null;
let partyDetail: PartyDetail;

function invoice(over: Partial<Invoice> & Pick<Invoice, "id" | "invoiceDate" | "remainingAmount">): Invoice {
  return {
    invoiceNumber: `INV-${over.id}`,
    kind: "SALE",
    counterpartyId: PARTY_ID,
    counterpartyName: "زبون",
    subtotalAmount: over.remainingAmount,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount: over.remainingAmount,
    paidAmount: 0,
    notes: null,
    createdAt: `${over.invoiceDate}T10:00:00`,
    updatedAt: `${over.invoiceDate}T10:00:00`,
    ...over,
  };
}

function makeDetail(invoices: Invoice[]): PartyDetail {
  const stats = invoices.reduce(
    (acc, entry) => ({
      invoiceCount: acc.invoiceCount + 1,
      totalAmount: acc.totalAmount + entry.totalAmount,
      paidAmount: acc.paidAmount + entry.paidAmount,
      remainingAmount: acc.remainingAmount + entry.remainingAmount,
    }),
    { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 },
  );
  return {
    party: { id: PARTY_ID, name: "زبون الاختبار", phone: "0550112233", createdAt: "2026-09-01T10:00:00" },
    stats,
    invoices,
    payments: [],
    account: null,
  };
}

// The page mounts the router Link and reads the partyId from the route.
mock.module("@tanstack/react-router", () => routerMock({ partyId: PARTY_ID }));

mock.module("@/lib/rpc", () => ({
  orpc: {
    customersGet: {
      queryOptions: () => ({
        queryKey: ["customersGet", PARTY_ID],
        queryFn: async () => {
          detailCalls += 1;
          if (detailCalls > 1 && detailGate !== null) await detailGate;
          return partyDetail;
        },
      }),
      queryKey: ({ input }: { input: { id: string } }) => ["customersGet", input.id],
    },
    suppliersGet: {
      queryOptions: () => ({ queryKey: ["suppliersGet", PARTY_ID], queryFn: async () => partyDetail, enabled: false }),
      queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id],
    },
    // #174 — the tabs page over the same party detail
    partyInvoices: {
      queryOptions: (options?: { input?: { unpaidOnly?: boolean; limit?: number; offset?: number } }) => ({
        queryKey: [["partyInvoices"], options?.input],
        queryFn: async () => {
          invoiceTabCalls += 1;
          const filtered = options?.input?.unpaidOnly === true ? partyDetail.invoices.filter((entry) => entry.remainingAmount > 0) : partyDetail.invoices;
          const limit = options?.input?.limit ?? 10;
          const offset = options?.input?.offset ?? 0;
          return { items: filtered.slice(offset, offset + limit), total: filtered.length };
        },
      }),
    },
    partyPayments: {
      queryOptions: (options?: { input?: { limit?: number; offset?: number } }) => ({
        queryKey: [["partyPayments"], PARTY_ID, options?.input],
        queryFn: async () => {
          const limit = options?.input?.limit ?? 10;
          const offset = options?.input?.offset ?? 0;
          return { items: partyDetail.payments.slice(offset, offset + limit), total: partyDetail.payments.length };
        },
      }),
    },
    supplierEntries: {
      queryOptions: () => ({
        queryKey: [["supplierEntries"], PARTY_ID],
        queryFn: async () => ({ items: partyDetail.account?.entries ?? [], total: partyDetail.account?.entries.length ?? 0 }),
      }),
    },
    invoicesPay: {
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["invoicesPay"],
        ...options,
        mutationFn: async (input: { invoiceId: string; amount: number; method?: string }) => {
          payInputs.push({ invoiceId: input.invoiceId, amount: input.amount, method: input.method });
          payCalls += 1;
          if (failPayAt > 0 && payCalls === failPayAt) throw new Error("PAYMENT_EXCEEDS_REMAINING");
          // #174 round 1 — model the server write so a later tab refetch can
          // observe it (the real api reduces remaining and records a payment)
          const invoiceNumber = partyDetail.invoices.find((entry) => entry.id === input.invoiceId)?.invoiceNumber ?? "INV-0000";
          partyDetail = {
            ...partyDetail,
            invoices: partyDetail.invoices.map((entry) =>
              entry.id === input.invoiceId
                ? { ...entry, paidAmount: entry.paidAmount + input.amount, remainingAmount: entry.remainingAmount - input.amount }
                : entry,
            ),
            payments: [
              ...partyDetail.payments,
              {
                id: `pay-${payCalls}`,
                invoiceId: input.invoiceId,
                invoiceNumber,
                amount: input.amount,
                // SAFETY: the settle panel only ever sends the CASH / BANK method
                method: (input.method ?? "CASH") as "CASH" | "BANK",
                note: null,
                paidAt: "2026-10-01T10:00:00",
                createdAt: "2026-10-01T10:00:00",
              },
            ],
          };
          return {};
        },
      }),
    },
    customersCreate: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    suppliersCreate: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    customersUpdate: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    suppliersUpdate: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    customersDelete: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    suppliersDelete: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
  },
  rpcClient: {},
}));

const { PartyDetailPage } = await import("./party-detail");
const { CustomerSettlePanel } = await import("@/components/parties/customer-settle-panel");

let host = document.createElement("div");
let roots: Array<{ unmount: () => void }> = [];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  payInputs = [];
  failPayAt = 0;
  payCalls = 0;
  detailCalls = 0;
  invoiceTabCalls = 0;
  detailGate = null;
  releaseDetailGate = null;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  host.remove();
});

async function renderCustomer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PartyDetailPage role="customer" />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (host.querySelector('[data-testid="party-detail-name"]') !== null) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("PartyDetailPage did not settle");
}

function click(testId: string) {
  act(() => {
    host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** sets a controlled input through the native setter + input event */
function typeInto(testId: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing input ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** #174 — the tab rows now arrive from a server page read, so poll. */
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition did not settle");
}

describe("customer detail unpaid view (#164)", () => {
  beforeEach(() => {
    partyDetail = makeDetail([
      invoice({ id: "1", invoiceDate: "2026-09-01", remainingAmount: 30_000, paidAmount: 0, totalAmount: 30_000 }),
      invoice({ id: "2", invoiceDate: "2026-09-18", remainingAmount: 0, paidAmount: 1_000, totalAmount: 1_000 }),
    ]);
  });

  it("opens on the unpaid invoices and shows the unpaid total", async () => {
    await renderCustomer();
    const filter = host.querySelector<HTMLInputElement>('[data-testid="party-unpaid-filter"]')!;
    expect(filter.checked).toBe(true);
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 1);
    expect(host.querySelectorAll('[data-testid="party-invoice-row"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="party-unpaid-total"]')?.textContent).toContain("30000");
  });

  it("shows every invoice once the unpaid filter is cleared", async () => {
    await renderCustomer();
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 1);
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="party-unpaid-filter"]')?.click();
    });
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 2);
    expect(host.querySelectorAll('[data-testid="party-invoice-row"]')).toHaveLength(2);
  });

  it("shows a teaching empty state when nothing is owed", async () => {
    partyDetail = makeDetail([invoice({ id: "paid", invoiceDate: "2026-09-01", remainingAmount: 0, paidAmount: 500, totalAmount: 500 })]);
    await renderCustomer();
    await waitFor(() => host.querySelector('[data-testid="party-invoices-empty"]') !== null);
    expect(host.querySelector('[data-testid="party-invoices-empty"]')?.textContent).toContain("لا توجد فواتير غير مدفوعة");
    expect(host.querySelector('[data-testid="party-settle"]')).toBeNull();
  });

  it("pages the invoices tab and resets to page 1 when the unpaid filter changes (#174)", async () => {
    const many = Array.from({ length: 12 }, (_, index) => invoice({ id: `p${index}`, invoiceDate: "2026-09-01", remainingAmount: 1_000 }));
    // one paid row so clearing the filter changes the total too
    many.push(invoice({ id: "paid", invoiceDate: "2026-09-02", remainingAmount: 0, paidAmount: 500, totalAmount: 500 }));
    partyDetail = makeDetail(many);
    await renderCustomer();
    // default page size 10: ten rows and a pager over the 12 unpaid invoices
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 10);
    expect(host.querySelector('[data-testid="party-invoices-pager"]')).not.toBeNull();
    click("party-invoices-pager-page-2");
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 2);
    expect(host.querySelector('[data-testid="party-invoices-pager-page-2"]')?.getAttribute("aria-current")).toBe("page");

    // a filter change invalidates the old offset: back to page 1
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="party-unpaid-filter"]')?.click();
    });
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 10);
    expect(host.querySelector('[data-testid="party-invoices-pager-page-1"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("pages the customer payments tab (#174)", async () => {
    partyDetail = makeDetail([]);
    partyDetail.payments = Array.from({ length: 12 }, (_, index) => ({
      id: `pay-${index}`,
      invoiceId: "inv",
      invoiceNumber: `INV-${index}`,
      amount: 100,
      method: "CASH" as const,
      note: null,
      paidAt: "2026-09-01T10:00:00",
      createdAt: "2026-09-01T10:00:00",
    }));
    await renderCustomer();
    click("party-tab-payments");
    await waitFor(() => host.querySelectorAll('[data-testid="party-payment-row"]').length === 10);
    expect(host.querySelector('[data-testid="party-payments-pager"]')).not.toBeNull();
    click("party-payments-pager-page-2");
    await waitFor(() => host.querySelectorAll('[data-testid="party-payment-row"]').length === 2);
    expect(host.querySelector('[data-testid="party-payments-pager-page-2"]')?.getAttribute("aria-current")).toBe("page");
  });
});

describe("customer settle in place (#164)", () => {
  beforeEach(() => {
    // the api returns newest first; the plan must settle the oldest first
    partyDetail = makeDetail([
      invoice({ id: "new", invoiceDate: "2026-09-18", invoiceNumber: "INV-0005", remainingAmount: 20_000, totalAmount: 20_000 }),
      invoice({ id: "old", invoiceDate: "2026-09-01", invoiceNumber: "INV-0003", remainingAmount: 30_000, totalAmount: 30_000 }),
    ]);
  });

  it("opens the #162 fields at the full unpaid total with the reference shown", async () => {
    await renderCustomer();
    click("party-settle");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-amount"]')?.value).toBe("50000");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-percentage"]')?.value).toBe("100");
    expect(host.querySelector('[data-testid="party-settle-reference"]')?.textContent).toContain("50000");
  });

  it("links the percentage to the amount", async () => {
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-percentage", "50");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-amount"]')?.value).toBe("25000");
  });

  it("previews the distribution oldest first, capped at each remaining", async () => {
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-amount", "40000");
    const rows = Array.from(host.querySelectorAll('[data-testid="party-settle-line"]'));
    const cells = rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()));
    // INV-0003 (oldest) takes its whole 30,000; INV-0005 takes the remaining 10,000
    expect(cells[0]?.[0]).toBe("INV-0003");
    expect(cells[0]?.[3]).toBe("30000 دج");
    expect(cells[1]?.[0]).toBe("INV-0005");
    expect(cells[1]?.[3]).toBe("10000 دج");
    expect(host.querySelector('[data-testid="party-settle-remaining"]')?.textContent).toContain("10000");
  });

  it("settles each invoice through invoicesPay on confirm, oldest first", async () => {
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-amount", "40000");
    const tabCallsBefore = invoiceTabCalls;
    click("party-settle-confirm");
    await flushAsync();
    expect(payInputs).toEqual([
      { invoiceId: "old", amount: 30_000, method: "CASH" },
      { invoiceId: "new", amount: 10_000, method: "CASH" },
    ]);
    // #174 — onDone invalidates the tab query with the correct oRPC prefix, so
    // the invoices tab refetches once the money moves (a string-first key would
    // be a silent no-op)
    await waitFor(() => invoiceTabCalls > tabCallsBefore);
    expect(host.querySelector('[data-testid="party-detail-notice"]')?.textContent).toContain("تم توزيع الدفعة");
    // ...and the all-success path refreshes the payments tab too
    click("party-tab-payments");
    await waitFor(() => host.querySelectorAll('[data-testid="party-payment-row"]').length === 2);
  });

  it("refreshes the paged tabs after a partly failed settle (issue #174 round 1)", async () => {
    partyDetail = makeDetail([
      invoice({ id: "first", invoiceNumber: "INV-0001", invoiceDate: "2026-09-01", remainingAmount: 1_000, totalAmount: 1_000 }),
      invoice({ id: "second", invoiceNumber: "INV-0002", invoiceDate: "2026-09-02", remainingAmount: 1_000, totalAmount: 1_000 }),
    ]);
    failPayAt = 2; // the oldest write lands, the second fails
    await renderCustomer();
    // show every invoice so the settled row stays visible WITHOUT changing the
    // query key (a filter change would refetch regardless of the fix)
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="party-unpaid-filter"]')?.click();
    });
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 2);

    click("party-settle");
    click("party-settle-confirm");
    await flushAsync();
    expect(host.querySelector('[data-testid="party-settle-halted"]')).not.toBeNull();
    expect(payInputs).toEqual([
      { invoiceId: "first", amount: 1_000, method: "CASH" },
      { invoiceId: "second", amount: 1_000, method: "CASH" },
    ]);

    // close the halted panel: the tabs must already carry the landed write,
    // so the paid invoice shows settled instead of staying unpaid
    click("party-settle-cancel");
    await waitFor(() => {
      const row = Array.from(host.querySelectorAll('[data-testid="party-invoice-row"]')).find((entry) => entry.textContent?.includes("INV-0001"));
      return row?.textContent?.includes("مسدّدة بالكامل") ?? false;
    });
    click("party-tab-payments");
    await waitFor(() => host.querySelectorAll('[data-testid="party-payment-row"]').length === 1);
    expect(host.querySelector('[data-testid="party-payment-row"]')?.textContent).toContain("INV-0001");
  });

  it("distributes a settle over every invoice, not just the visible page (#174)", async () => {
    // twelve unpaid invoices span two pages (default page size 10), but the
    // settle reference and plan must walk the FULL partyDetail set
    partyDetail = makeDetail(
      Array.from({ length: 12 }, (_, index) =>
        invoice({ id: `bulk-${index}`, invoiceNumber: `INV-1${String(index).padStart(3, "0")}`, invoiceDate: "2026-09-01", remainingAmount: 1_000, totalAmount: 1_000 }),
      ),
    );
    await renderCustomer();
    await waitFor(() => host.querySelectorAll('[data-testid="party-invoice-row"]').length === 10);
    click("party-settle");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-amount"]')?.value).toBe("12000");
    click("party-settle-confirm");
    await flushAsync();
    expect(payInputs).toHaveLength(12);
    expect(payInputs.reduce((sum, entry) => sum + entry.amount, 0)).toBe(12_000);
  });

  it("halts after a mid-loop failure so a second confirm cannot resend money", async () => {
    failPayAt = 2;
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-amount", "40000");
    click("party-settle-confirm");
    await flushAsync();
    // both were attempted; the second is the one that failed
    expect(payInputs).toEqual([
      { invoiceId: "old", amount: 30_000, method: "CASH" },
      { invoiceId: "new", amount: 10_000, method: "CASH" },
    ]);
    expect(host.querySelector('[data-testid="party-settle-error"]')?.textContent).toContain("يتجاوز");
    expect(host.querySelector('[data-testid="party-settle-halted"]')).not.toBeNull();
    // the halted panel refuses a second confirm: nothing more is sent. A raw
    // form submit bypasses the disabled button, so the guard must block it too.
    const form = host.querySelector<HTMLFormElement>('[data-testid="party-settle-panel"]')!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    click("party-settle-confirm");
    await flushAsync();
    expect(payInputs).toHaveLength(2);
  });

  it("refuses an invalid settle percentage and records nothing (#171)", async () => {
    partyDetail = makeDetail([invoice({ id: "only", invoiceDate: "2026-09-01", remainingAmount: 1_000, totalAmount: 1_000 })]);
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-percentage", "12.5");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-percentage"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="party-settle-confirm"]')?.disabled).toBe(true);
    // the error is live, not only on submit
    expect(host.querySelector('[data-testid="party-settle-error"]')?.textContent).toBeTruthy();
    const form = host.querySelector<HTMLFormElement>('[data-testid="party-settle-panel"]')!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(payInputs).toEqual([]);
  });

  it("holds the submit guard across the refresh so a double-activate records one payment (#171)", async () => {
    partyDetail = makeDetail([invoice({ id: "only", invoiceDate: "2026-09-01", remainingAmount: 1_000, totalAmount: 1_000 })]);
    // hold the customersGet refetch that runs after the payment, so the panel
    // stays in the window where `pay.isPending` has already ended
    detailGate = new Promise((resolve) => {
      releaseDetailGate = resolve;
    });
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-amount", "200");
    const form = host.querySelector<HTMLFormElement>('[data-testid="party-settle-panel"]')!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(payInputs).toHaveLength(1);
    // wait until the gated refresh is actually in flight
    for (let attempt = 0; attempt < 50 && detailCalls < 2; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(detailCalls).toBeGreaterThanOrEqual(2);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="party-settle-confirm"]')?.disabled).toBe(true);
    // a raw form submit bypasses the disabled button and must still be a no-op
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(payInputs).toHaveLength(1);
    await act(async () => {
      releaseDetailGate?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(payInputs).toHaveLength(1);
  });

  it("refuses an amount above what is owed and sends nothing", async () => {
    await renderCustomer();
    click("party-settle");
    typeInto("party-settle-amount", "50001");
    click("party-settle-confirm");
    await flushAsync();
    expect(host.querySelector('[data-testid="party-settle-error"]')?.textContent).toContain("يتجاوز المتبقي");
    expect(payInputs).toEqual([]);
  });

  it("keeps the supplier invoices tab unfiltered and without a settle action", async () => {
    partyDetail = makeDetail([invoice({ id: "1", invoiceDate: "2026-09-01", remainingAmount: 100, totalAmount: 100 })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PartyDetailPage role="supplier" />
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (host.querySelector('[data-testid="party-detail-name"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    // never pass vacuously: the page must have rendered before the negatives
    expect(host.querySelector('[data-testid="party-detail-name"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="party-unpaid-filter"]')).toBeNull();
    expect(host.querySelector('[data-testid="party-settle"]')).toBeNull();
  });
});

/**
 * #171 — the settle panel must relink when its reference (the unpaid total)
 * changes underneath it, with the edited field staying the source.
 */
describe("CustomerSettlePanel reference-change relink (#171)", () => {
  const invoices = [invoice({ id: "only", invoiceDate: "2026-09-01", remainingAmount: 2_000, totalAmount: 2_000 })];

  const amount = () => host.querySelector<HTMLInputElement>('[data-testid="party-settle-amount"]')?.value;
  const percentage = () => host.querySelector<HTMLInputElement>('[data-testid="party-settle-percentage"]')?.value;

  /** renders once, then re-renders the SAME panel with a new unpaid total */
  function renderSettle(unpaid: number) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const root = createRoot(host);
    roots.push(root);
    const renderWith = (next: number) =>
      root.render(
        <QueryClientProvider client={client}>
          <CustomerSettlePanel partyId={PARTY_ID} invoices={invoices} unpaid={next} onDone={() => undefined} onCancel={() => undefined} />
        </QueryClientProvider>,
      );
    act(() => renderWith(unpaid));
    return renderWith;
  }

  it("follows the new unpaid total under an untouched pair", () => {
    const renderWith = renderSettle(1_000);
    expect(amount()).toBe("1000");
    expect(percentage()).toBe("100");
    act(() => renderWith(1_500));
    expect(amount()).toBe("1500");
    expect(percentage()).toBe("100");
  });

  it("keeps an edited amount as the source and re-derives the percentage", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-amount", "400");
    expect(percentage()).toBe("40");
    act(() => renderWith(1_500));
    expect(amount()).toBe("400");
    expect(percentage()).toBe("27");
  });

  it("keeps an edited percentage as the source and rescales the amount", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-percentage", "50");
    expect(amount()).toBe("500");
    act(() => renderWith(2_000));
    expect(percentage()).toBe("50");
    expect(amount()).toBe("1000");
  });

  it("zeroes a percentage-based draft when the unpaid total falls to zero", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-percentage", "50");
    expect(amount()).toBe("500");
    act(() => renderWith(0));
    expect(amount()).toBe("0");
  });

  it("clears an untouched pair when the unpaid total falls to zero", () => {
    const renderWith = renderSettle(1_000);
    act(() => renderWith(0));
    expect(amount()).toBe("");
    expect(host.querySelector('[data-testid="party-settle-percentage"]')).toBeNull();
  });

  it("keeps an edited amount when the unpaid total falls to zero", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-amount", "400");
    act(() => renderWith(0));
    expect(amount()).toBe("400");
    // over the (now zero) reference: confirm is blocked
    expect(host.querySelector<HTMLButtonElement>('[data-testid="party-settle-confirm"]')?.disabled).toBe(true);
  });

  it("keeps an invalid percentage flagged across a reference change", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-percentage", "12.5");
    expect(amount()).toBe("");
    act(() => renderWith(2_000));
    expect(amount()).toBe("");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-settle-percentage"]')?.getAttribute("aria-invalid")).toBe("true");
  });

  it("relinks a percentage draft through a zero and back up", () => {
    const renderWith = renderSettle(1_000);
    typeInto("party-settle-percentage", "50");
    expect(amount()).toBe("500");
    act(() => renderWith(0));
    expect(amount()).toBe("0");
    act(() => renderWith(2_000));
    expect(percentage()).toBe("50");
    expect(amount()).toBe("1000");
  });
});
