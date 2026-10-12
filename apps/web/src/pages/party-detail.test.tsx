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
    invoicesPay: {
      mutationOptions: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["invoicesPay"],
        ...options,
        mutationFn: async (input: { invoiceId: string; amount: number; method?: string }) => {
          payInputs.push({ invoiceId: input.invoiceId, amount: input.amount, method: input.method });
          payCalls += 1;
          if (failPayAt > 0 && payCalls === failPayAt) throw new Error("PAYMENT_EXCEEDS_REMAINING");
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
    expect(host.querySelectorAll('[data-testid="party-invoice-row"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="party-unpaid-total"]')?.textContent).toContain("30000");
  });

  it("shows every invoice once the unpaid filter is cleared", async () => {
    await renderCustomer();
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="party-unpaid-filter"]')?.click();
    });
    expect(host.querySelectorAll('[data-testid="party-invoice-row"]')).toHaveLength(2);
  });

  it("shows a teaching empty state when nothing is owed", async () => {
    partyDetail = makeDetail([invoice({ id: "paid", invoiceDate: "2026-09-01", remainingAmount: 0, paidAmount: 500, totalAmount: 500 })]);
    await renderCustomer();
    expect(host.querySelector('[data-testid="party-invoices-empty"]')?.textContent).toContain("لا توجد فواتير غير مدفوعة");
    expect(host.querySelector('[data-testid="party-settle"]')).toBeNull();
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
    click("party-settle-confirm");
    await flushAsync();
    expect(payInputs).toEqual([
      { invoiceId: "old", amount: 30_000, method: "CASH" },
      { invoiceId: "new", amount: 10_000, method: "CASH" },
    ]);
    expect(host.querySelector('[data-testid="party-detail-notice"]')?.textContent).toContain("تم توزيع الدفعة");
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
