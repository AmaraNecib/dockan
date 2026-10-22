import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { DebtSummary, Invoice, InvoiceDetail, ReturnDetail } from "@dokan/contracts";

import { routerMock } from "../tests/router-mock";

/**
 * #323 — one party, one cache identity.
 *
 * A party is keyed by its id on one screen and by its id AND the typed name on
 * the other, so the two screens held two cache entries for the same party and
 * a payment invalidated one of them. The open screen kept previewing a refund
 * against a total the write had already moved.
 *
 * These tests drive the real screens through their real surfaces: the debts
 * screen (the drill-down), the invoice screen (the refund preview) and the
 * party screen (the settle panel), all on ONE query cache — which is what a
 * shop owner has when two tabs are open.
 */

const PARTY_ID = "00000000-0000-4000-8000-0000000000f1";
const INVOICE_ID = "00000000-0000-4000-8000-0000000000f2";
const OPEN_INVOICE_ID = "00000000-0000-4000-8000-0000000000f3";
const LINE_ID = "00000000-0000-4000-8000-0000000000f4";
const ITEM_ID = "00000000-0000-4000-8000-0000000000f5";

/** the customer's open invoices — the tab `debtsByParty` returns */
let openInvoices: Array<{ id: string; remainingAmount: number }> = [];
/**
 * Every party-balance READ the screens actually issued, in order. The no-read
 * test needs reads, not cache keys: a disabled query keeps an entry under a key
 * whose name it was given, so inspecting keys cannot tell a fetch from an idle
 * entry. Cleared by `renderScreens`.
 */
let partyReads: Array<{ counterpartyId: string | null; counterpartyName: string | null }> = [];
/** the debts screen's rows */
let owedToUs: DebtSummary[] = [];
let weOwe: DebtSummary[] = [];

// the page modules import the router Link at module scope; the shared stub
// keeps the screens testable without a router mount
mock.module("@tanstack/react-router", routerMock);

mock.module("@/lib/rpc", () => ({
  orpc: {
    reportsDebts: {
      queryOptions: () => ({
        queryKey: ["reportsDebts"],
        queryFn: async () => ({ owedToUs, weOwe }),
      }),
      queryKey: () => ["reportsDebts"],
    },
    debtsByParty: {
      // the key carries the party's identity, so both screens read the SAME
      // party under one entry
      queryOptions: ({ input }: { input: { kind: string; counterpartyId: string | null; counterpartyName: string | null } }) => ({
        queryKey: ["debtsByParty", input],
        queryFn: async () => {
          partyReads.push({ counterpartyId: input.counterpartyId, counterpartyName: input.counterpartyName });
          const items = openInvoices
            .filter((row) => row.remainingAmount > 0)
            .map((row) => ({ remainingAmount: row.remainingAmount }));
          return { items, total: items.length };
        },
      }),
      queryKey: ({ input }: { input: { kind: string; counterpartyId: string | null; counterpartyName: string | null } }) => ["debtsByParty", input],
    },
    suppliersGet: {
      queryOptions: () => ({ queryKey: ["suppliersGet", ""], queryFn: async () => ({ account: null }) }),
      queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id],
    },
    customersGet: { queryKey: ({ input }: { input: { id: string } }) => ["customersGet", input.id] },
    invoicesGet: { queryKey: ({ input }: { input: { id: string } }) => ["invoicesGet", input] },
    invoicesList: { queryKey: () => ["invoicesList"] },
    activitiesList: { queryKey: () => ["activitiesList"] },
    returnsPendingCount: { queryKey: () => ["returnsPendingCount"] },
    invoicesPay: {
      mutationOptions: () => ({
        mutationKey: ["invoicesPay"],
        mutationFn: async (input: { invoiceId: string; amount: number }) => {
          // the server settles the invoice: its remaining drops, and a settled
          // invoice leaves the customer's tab
          const target = openInvoices.find((row) => row.id === input.invoiceId);
          if (target === undefined) throw new Error("INVOICE_NOT_FOUND");
          if (input.amount > target.remainingAmount) throw new Error("PAYMENT_EXCEEDS_REMAINING");
          target.remainingAmount = Math.max(0, target.remainingAmount - input.amount);
          return {};
        },
      }),
    },
    returnsForInvoice: {
      queryOptions: () => ({ queryKey: ["returnsForInvoice"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["returnsForInvoice"],
    },
    returnsCreate: {
      mutationOptions: (options?: { onSuccess?: (record: ReturnDetail) => void; onError?: (error: Error) => void }) => ({
        mutationKey: ["returnsCreate"],
        ...options,
        mutationFn: async () => ({}),
      }),
    },
  },
  rpcClient: {},
}));

const { DebtsPage } = await import("./debts");
const { ReturnsPanel } = await import("./invoice");
const { CustomerSettlePanel } = await import("../components/parties/customer-settle-panel");

const summary = (over: Partial<DebtSummary> = {}): DebtSummary => ({
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  kind: "SALE" as const,
  remainingTotal: 900,
  invoiceCount: 1,
  oldestInvoiceDate: "2026-08-01",
  latestInvoiceDate: "2026-08-01",
  accountBalance: null,
  ...over,
});

/** the invoice screen's invoice: paid in full, so the party's TAB is what the
 * refund preview is derived from */
const invoiceDetail = (over: Partial<InvoiceDetail> = {}): InvoiceDetail => ({
  id: INVOICE_ID,
  invoiceNumber: "INV-0301",
  kind: "SALE",
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  invoiceDate: "2026-08-01",
  subtotalAmount: 900,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  totalAmount: 900,
  paidAmount: 900,
  remainingAmount: 0,
  returnCreditAmount: 0,
  notes: null,
  createdAt: "2026-08-01T10:00:00",
  updatedAt: "2026-08-01T10:00:00",
  lines: [
    {
      id: LINE_ID,
      invoiceId: INVOICE_ID,
      itemId: ITEM_ID,
      description: "بطارية",
      quantity: 4,
      defaultUnitPrice: 900,
      unitPrice: 900,
      costAtSale: 400,
      cogsExact: 1600,
      total: 3600,
      discountAllocated: 0,
      netTotal: 3600,
    },
  ],
  payments: [],
  ...over,
});

/** the party's open invoice, the one the settle panel pays */
const openInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: OPEN_INVOICE_ID,
  invoiceNumber: "INV-0302",
  invoiceDate: "2026-08-01",
  createdAt: "2026-08-01T10:00:00",
  updatedAt: "2026-08-01T10:00:00",
  kind: "SALE",
  counterpartyId: PARTY_ID,
  counterpartyName: "زبون",
  totalAmount: 900,
  paidAmount: 0,
  remainingAmount: 900,
  subtotalAmount: 900,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  openInvoices = [];
  owedToUs = [];
  weOwe = [];
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  queryClient?.clear();
  queryClient = null;
  host.remove();
});

/** mounts the given screens on ONE query cache, the way two open tabs share it */
function renderScreens(children: ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  partyReads = [];
  queryClient = client;
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    );
  });
  return client;
}

/** Sets a controlled input through the native setter + input event so React's
 * onChange fires (plain .value assignment is ignored by React's tracker). */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** act-wrapped polling, so a refetch and its re-render both land */
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return false;
}

/** the cache entries one party is read under */
function partyBalanceEntries(client: QueryClient, partyId: string) {
  return client
    .getQueryCache()
    .findAll({ queryKey: ["debtsByParty"] })
    .map((query) => {
      // SAFETY: the mocked key is ["debtsByParty", input]; the second element
      // is the party's identity, or undefined for a key that carries none
      const input = query.queryKey[1] as { kind: string; counterpartyId: string | null; counterpartyName: string | null } | undefined;
      return input;
    })
    .filter((input) => input?.counterpartyId === partyId);
}

describe("one party, one cache identity (#323)", () => {
  it("reads the same party under one key on the debts screen and the invoice screen", async () => {
    owedToUs = [summary()];
    const client = renderScreens(
      <>
        <DebtsPage />
        <ReturnsPanel invoice={invoiceDetail()} />
      </>,
    );
    await flushAsync();

    // the debts screen opens the party's drill-down
    const row = host.querySelector<HTMLButtonElement>('[data-testid="debts-person"]');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    // ONE party, ONE cache entry: the two screens must not hold a second copy
    // of the same party under a different key
    const entries = partyBalanceEntries(client, PARTY_ID);
    expect(entries).toHaveLength(1);
    // and the key is derived from the id alone: the name is not part of it
    expect(entries[0]?.counterpartyName).toBeNull();
    expect(entries[0]?.kind).toBe("SALE");
  });

  it("moves the invoice screen's refund preview when a payment lands on the party screen", async () => {
    // the customer owes 900 on ANOTHER invoice; the invoice on screen is paid
    // in full, so the preview is derived from the party's tab
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(
      <>
        <ReturnsPanel invoice={invoiceDetail()} />
        <CustomerSettlePanel
          partyId={PARTY_ID}
          invoices={[openInvoice()]}
          unpaid={900}
          onDone={() => undefined}
          onWriteFailed={() => undefined}
          onCancel={() => undefined}
        />
      </>,
    );
    await flushAsync();

    // return one unit: the tab covers it, so the refund comes off the debt
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("900");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("0");

    // the party screen records the payment
    submitForm(host.querySelector<HTMLFormElement>('[data-testid="party-settle-panel"]')!);
    await flushAsync();

    // the tab is empty now, so the SAME preview must offer cash instead: the
    // payment moved it without a manual refresh
    const moved = await waitFor(
      () => host.querySelector('[data-testid="returns-cash-now"]')?.textContent?.includes("900") ?? false,
    );
    expect(moved).toBe(true);
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("0");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("900");
  });

  // #323 review (Greptile P1) — the invalidation above reaches the WRITING
  // window's cache only. A second window has its own QueryClient and no focus
  // event is exchanged between two windows side by side, so the only thing that
  // converges it is the bounded tick. This test proves the tick alone moves the
  // preview: nothing invalidates this cache, the server's data changes underneath.
  it("re-reads the party's tab on the tick, so a payment in another window lands without an invalidation", async () => {
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(<ReturnsPanel invoice={invoiceDetail()} refreshMs={20} />);
    await flushAsync();

    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");
    await flushAsync();
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("900");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("0");

    // the other window records the payment: the server's answer changes and this
    // cache is told NOTHING — no invalidateQueries, no refetch call, no focus
    openInvoices = [];
    const converged = await waitFor(
      () => host.querySelector('[data-testid="returns-cash-now"]')?.textContent?.includes("900") ?? false,
    );
    expect(converged).toBe(true);
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("0");
  });

  // #323 review — the refusal path had no test at all, and the author review
  // named it as the likeliest silent regression. A party with neither an id nor
  // a usable name has no key, so the drill-down says so instead of drawing an
  // empty invoice table.
  it("refuses a party that has no id and no usable name, and reads nothing under a nameless key", async () => {
    owedToUs = [summary({ counterpartyId: null, counterpartyName: "   " })];
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(<DebtsPage />);
    await flushAsync();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="debts-person"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(host.querySelector('[data-testid="debts-party-unidentified"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="debts-invoices"]')).toBeNull();
    // and no read was ever issued: the nameless key is the key of every other
    // nameless party, so a fetch under it would hand this row someone else's money.
    // Asserting on READS, not on cache keys — a disabled query keeps an entry under
    // whatever name it was handed, so a key filter proves nothing either way.
    expect(partyReads).toHaveLength(0);
  });

  // #337 — the server returns ONE identity per party and trims the label with
  // the same JavaScript set the client trims with (`trimSql` in
  // `apps/api/src/store/trim-chars.ts` feeds both its group key and its
  // drill-down WHERE), so no spelling of a readable name has to be refused any
  // more. Refusing one turned a readable tab into an anonymous one, and the
  // anonymous fallback promises cash for a refund the server offsets.
  //
  // The padding here is deliberately drawn from across the set (space, NBSP,
  // tab), not just spaces: plain spaces were already readable through sqlite's
  // own TRIM() and could not prove the rule.
  it("reads a padded label under its trimmed name, the one identity the server returns (#337)", async () => {
    owedToUs = [summary({ counterpartyId: null, counterpartyName: " \u00A0زبون\t" })];
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(<DebtsPage />);
    await flushAsync();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="debts-person"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(host.querySelector('[data-testid="debts-party-unidentified"]')).toBeNull();
    expect(host.querySelector('[data-testid="debts-invoices"]')).not.toBeNull();
    // and the read went out under the name the wire can express — the trimmed
    // one the server itself groups under
    expect(partyReads).toEqual([{ counterpartyId: null, counterpartyName: "زبون" }]);
  });

  // #337 review (Greptile P2 on #360) — the deleted #323 refusal test guarded
  // the money path this PR reopened: a PAID invoice, a padded typed name, debt
  // on ANOTHER invoice. #337 removes the refusal because the server returns one
  // identity per party, so the read RESOLVES now — and once it resolves, the
  // refund must offset that other invoice's debt, not offer cash. That is the
  // path with money in it, and the replacement DebtsPage test does not render it.
  // The padding here is NBSP, the trim-set character plain spaces could not
  // prove (sqlite's own TRIM(U+0020) already read those).
  it("offsets the other invoice's debt once the padded name's read resolves (#337)", async () => {
    openInvoices = [{ id: OPEN_INVOICE_ID, remainingAmount: 900 }];
    renderScreens(
      <ReturnsPanel
        invoice={invoiceDetail({ counterpartyId: null, counterpartyName: "زبون\u00A0", remainingAmount: 0 })}
      />,
    );
    // no flush before the typing: the padded name's read fired on mount and no
    // microtask has drained since, so it is deterministically still in flight —
    // the split cannot be priced from a read that has not landed
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="returns-qty-بطارية"]')!, "1");

    // while the read is pending the split stays UNKNOWN — the projection block
    // (which holds the cash line) is not rendered at all, so cash is never
    // promised before the answer arrives
    expect(host.querySelector('[data-testid="returns-split-unknown"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="returns-cash-now"]')).toBeNull();

    await flushAsync();
    // resolved: the tab covers the 900 return, so the refund comes off the
    // OTHER invoice's debt and the cash line settles at 0 — the server offsets,
    // it does not pay
    expect(host.querySelector('[data-testid="returns-debt-offset"]')?.textContent).toContain("900");
    expect(host.querySelector('[data-testid="returns-cash-now"]')?.textContent).toContain("0");
    // (the cash element exists at 0, unlike the old refusal where it vanished:
    // #337 resolves the read instead of refusing it, so the settled answer is
    // "no cash" rather than "no answer")

    // and the read went out under the trimmed name — the identity the server
    // itself groups under, which is why the resolution covers both spellings
    expect(partyReads).toEqual([{ counterpartyId: null, counterpartyName: "زبون" }]);
  });
});
