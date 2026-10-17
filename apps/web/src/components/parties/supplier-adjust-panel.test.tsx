import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { Invoice, SupplierAdjustmentDirection } from "@dokan/contracts";

type AdjustInput = {
  supplierId: string;
  direction: SupplierAdjustmentDirection;
  amount: number;
  reason?: string;
  occurredAt?: string;
  invoiceId?: string;
};

let captured: AdjustInput | null = null;
mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersAdjust: {
      mutationOptions: () => ({
        mutationKey: ["suppliersAdjust"],
        mutationFn: async (input: AdjustInput) => {
          captured = input;
          return { balance: 0, entries: [] };
        },
      }),
    },
    suppliersGet: { queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id] },
    reportsDebts: { queryKey: () => ["reportsDebts"] },
    dashboardSummary: { queryKey: () => ["dashboardSummary"] },
  },
  DEBTS_BY_PARTY_QUERY_KEY: [["debtsByParty"]],
  rpcClient: {},
}));

const { SupplierAdjustPanel } = await import("./supplier-adjust-panel");

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  invoiceNumber: "INV-0007",
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  kind: "PURCHASE",
  counterpartyId: "sup-1",
  counterpartyName: "مورد",
  totalAmount: 5000,
  paidAmount: 0,
  remainingAmount: 5000,
  subtotalAmount: 5000,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  updatedAt: "2026-01-01T10:00:00",
  ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  captured = null;
  queryClient = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

function tree(invoices: Invoice[]) {
  return (
    <QueryClientProvider client={queryClient!}>
      <SupplierAdjustPanel supplierId="sup-1" supplierName="مورد الاختبار" balance={5000} invoices={invoices} onDone={() => undefined} onCancel={() => undefined} />
    </QueryClientProvider>
  );
}

function render(invoices: Invoice[] = [invoice()]) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(tree(invoices));
  });
}

/** Re-render the SAME panel with a new invoices prop (the background refresh). */
function rerender(invoices: Invoice[]) {
  act(() => {
    root!.render(tree(invoices));
  });
}

function input(testId: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  return el;
}

function typeInto(testId: string, text: string) {
  const el = input(testId);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickOn(testId: string) {
  const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  act(() => el.click());
}

describe("SupplierAdjustPanel (issue 176)", () => {
  it("saves an account-only adjustment with the chosen direction and no invoice", async () => {
    render();
    clickOn("supplier-adjust-direction-they-owe");
    typeInto("supplier-adjust-amount", "500");
    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    expect(captured).toMatchObject({ supplierId: "sup-1", direction: "THEY_OWE", amount: 500 });
    expect(captured?.invoiceId).toBeUndefined();
    // the account-only preview explicitly says no invoice changes
    expect(host.querySelector('[data-testid="supplier-adjust-preview"]')?.textContent).toContain("لا تتغيّر");
  });

  it("links the invoice, forces the reducing direction (THEY_OWE), and refuses an amount above the remaining", () => {
    render();
    clickOn("supplier-adjust-link");
    // linking forces the reducing direction, so the increase button is disabled
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-direction-we-owe"]')?.disabled).toBe(true);

    typeInto("supplier-adjust-amount", "6000");
    expect(host.querySelector('[data-testid="supplier-adjust-error"]')?.textContent).toContain("يتجاوز");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);

    // a fitting amount previews the invoice remaining after saving
    typeInto("supplier-adjust-amount", "500");
    expect(host.querySelector('[data-testid="supplier-adjust-preview-remaining"]')?.textContent).toContain("4500");
  });

  /**
   * #252 — the panel's two buttons are the other place a direction label sits. The
   * label and the hint beside it are resolved from the same direction, so this pins
   * the pair: a label moved to the other value (the reported bug) or a hint moved
   * to the other value (a fake fix) both redden here.
   */
  it("#252 — each direction button shows the Darija its own hint describes", () => {
    render();
    const weOwe = host.querySelector<HTMLElement>('[data-testid="supplier-adjust-direction-we-owe"]');
    const theyOwe = host.querySelector<HTMLElement>('[data-testid="supplier-adjust-direction-they-owe"]');

    expect(weOwe?.textContent).toBe("يسالنا");
    expect(weOwe?.getAttribute("title")).toContain("نحن ندين له");
    expect(theyOwe?.textContent).toBe("نسالوه");
    expect(theyOwe?.getAttribute("title")).toContain("هو يدين لنا");
  });

  /** #252 — the other half of the same pin: the button that reads «يسالنا» must
   * SUBMIT WE_OWE. Starting from THEY_OWE first, so a button whose handler does
   * nothing (or sets the opposite value) cannot pass by leaving the default. */
  it("#252 — the 'we owe him' button moves the draft back to WE_OWE", async () => {
    render();
    clickOn("supplier-adjust-direction-they-owe");
    clickOn("supplier-adjust-direction-we-owe");
    typeInto("supplier-adjust-amount", "250");
    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    expect(captured).toMatchObject({ direction: "WE_OWE", amount: 250 });
  });

  /**
   * #252 — the same raw-value defect as the direction selects: this `<Select>`
   * had no `items` map on its root, so the trigger printed the invoice UUID while
   * the popup printed invoice numbers. Found by the new AST guard in
   * `lib/select-trigger-label.test.ts`.
   */
  it("#252 — the linked-invoice trigger reads the invoice number, not its id", () => {
    render([invoice({ id: "inv-raw-uuid-252", invoiceNumber: "INV-9001" })]);
    clickOn("supplier-adjust-link");

    // the trigger also carries the chevron icon; the label lives in the SelectValue
    // span, which is the element Base UI resolves from the root's `items` map
    const trigger = host.querySelector<HTMLElement>('[data-testid="supplier-adjust-invoice"]');
    const value = trigger?.querySelector('[data-slot="select-value"]');
    expect(value?.textContent).toBe("INV-9001");
    expect(trigger?.textContent).not.toContain("inv-raw-uuid-252");
  });

  it("offers no link when there is no open purchase invoice", () => {
    render([]);
    clickOn("supplier-adjust-link");
    expect(host.querySelector('[data-testid="supplier-adjust-no-invoices"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
  });

  it("treats a mark-only amount as blank: no error text, confirm stays disabled (#244)", () => {
    render();
    // a bidi mark is Cf, not whitespace: the raw gate called it a chosen amount
    // and showed the required-message, though the field holds no number
    typeInto("supplier-adjust-amount", "\u200f");
    expect(host.querySelector('[data-testid="supplier-adjust-error"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("never auto-switches the linked invoice when the selected one is no longer open (Greptile finding 2)", () => {
    render([invoice({ id: "inv-a", invoiceNumber: "INV-A" }), invoice({ id: "inv-b", invoiceNumber: "INV-B" })]);
    clickOn("supplier-adjust-link");
    // the owner's selected invoice A settles in another tab; a refresh drops it
    rerender([invoice({ id: "inv-b", invoiceNumber: "INV-B" })]);
    typeInto("supplier-adjust-amount", "100");

    expect(host.querySelector('[data-testid="supplier-adjust-link-error"]')?.textContent).toContain("لم تعد مفتوحة");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
    clickOn("supplier-adjust-confirm");
    // nothing was submitted, and B was never silently discounted
    expect(captured).toBeNull();
  });

  it("accepts the same grouped amount as the bulk opening-balance screen (#180)", async () => {
    render();
    clickOn("supplier-adjust-direction-they-owe");
    typeInto("supplier-adjust-amount", "1 000");
    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    // the shared grouped parser: `1 000` is 1000 here, exactly as in the bulk rows
    expect(captured).toMatchObject({ supplierId: "sup-1", direction: "THEY_OWE", amount: 1000 });
  });

  it("rejects a decimal-grouped amount instead of guessing 100x (#180)", async () => {
    render();
    await act(async () => {
      typeInto("supplier-adjust-amount", "1 000,00");
    });
    expect(host.querySelector('[data-testid="supplier-adjust-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="supplier-adjust-confirm"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("invalidates the real debts and dashboard keys after saving (Greptile finding 5)", async () => {
    render();
    typeInto("supplier-adjust-amount", "500");
    const spy = spyOn(queryClient!, "invalidateQueries");

    await act(async () => {
      clickOn("supplier-adjust-confirm");
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["reportsDebts"]));
    expect(keys).toContain(JSON.stringify([["debtsByParty"]]));
    expect(keys).toContain(JSON.stringify(["dashboardSummary"]));
    expect(keys).toContain(JSON.stringify([["invoicesList"]]));
    expect(keys).toContain(JSON.stringify([["activitiesList"]]));
    expect(keys).not.toContain(JSON.stringify(["debtsData"]));
  });
});
