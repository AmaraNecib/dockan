import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly;
// only this flag is written and globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";

import type { Invoice, SupplierReturn } from "@dokan/contracts";

const submitted: SupplierReturn[] = [];
const doneCalls: string[] = [];
mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersReturn: {
      mutationOptions: (options?: { onSuccess?: () => void }) => ({
        mutationKey: ["suppliersReturn"],
        ...options,
        mutationFn: async (input: SupplierReturn) => {
          submitted.push(input);
          return {};
        },
      }),
    },
    invoicesGet: {
      queryOptions: () => ({
        queryKey: ["invoicesGet", "inv-1"],
        queryFn: async () => ({
          id: "inv-1",
          kind: "PURCHASE",
          // two fixtures, not one: l1 keeps the zero-price "free line" case
          // alive (#229 finding 2) while l2 gives the #210 preview pins a
          // non-zero product, so a wrong reader shows 400000/600 not 0
          lines: [
            { id: "l1", itemId: "item-1", description: "هدية", quantity: 5, unitPrice: 0, netTotal: 0 },
            { id: "l2", itemId: "item-1", description: "هدية", quantity: 5, unitPrice: 400, netTotal: 2000 },
          ],
        }),
      }),
    },
    itemsAll: {
      queryOptions: () => ({ queryKey: ["itemsAll"], queryFn: async () => ({ items: [{ id: "item-1", name: "هدية" }] }) }),
      // refresh() calls this after a successful save; without it the save throws
      // in the success path and onDone never runs (issue #163 review)
      queryKey: () => ["itemsAll"],
    },
    suppliersGet: { queryKey: ({ input }: { input: { id: string } }) => ["suppliersGet", input.id] },
    suppliersReturnsList: { queryKey: () => ["suppliersReturnsList"] },
  },
  rpcClient: {},
}));

const { SupplierReturnPanel } = await import("./supplier-return-panel");

const invoice: Invoice = {
  id: "inv-1",
  invoiceNumber: "INV-0001",
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  kind: "PURCHASE",
  counterpartyId: "sup-1",
  counterpartyName: "مورد",
  totalAmount: 0,
  paidAmount: 0,
  remainingAmount: 0,
  subtotalAmount: 0,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  notes: null,
  updatedAt: "2026-01-01T10:00:00",
};

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  submitted.length = 0;
  doneCalls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
  // Select popups render into a body portal; clear any stragglers
  document.body.innerHTML = "";
});

async function render(balance = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierReturnPanel supplierId="sup-1" balance={balance} invoices={[invoice]} onDone={() => doneCalls.push("done")} onCancel={() => undefined} />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (host.querySelector('[data-testid="supplier-return-lines"]') !== null) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("return lines did not render");
}

function typeInto(testId: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function confirmButton() {
  return host.querySelector<HTMLButtonElement>('[data-testid="supplier-return-confirm"]');
}

/** The previewed return value as a number. The rendered element is "label: 2000 دج",
 * so extract the last digit run instead of substring-matching (a bare
 * `toContain("0")` also matches 400000, the value the old loose reader showed). */
function previewAmount(): number {
  const text = host.querySelector('[data-testid="supplier-return-value"]')?.textContent ?? "";
  return Number(text.match(/(\d+)(?!.*\d)/u)?.[1] ?? Number.NaN);
}

async function submit() {
  const form = host.querySelector<HTMLFormElement>('[data-testid="supplier-return-panel"]');
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Open a Base UI Select trigger and click the option whose label contains `optionText`. */
async function openSelect(testId: string, optionText: string) {
  const trigger = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (trigger === null) throw new Error(`missing ${testId}`);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (document.querySelectorAll("[role='option']").length > 0) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((element) => element.textContent?.includes(optionText));
  if (option === undefined) throw new Error(`missing option ${optionText}`);
  act(() => {
    // Base UI items arm mouse selection on pointerdown, then commit on click.
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
  });
}

describe("SupplierReturnPanel draft validation (findings 3 and 8)", () => {
  it("enables submit for a valid quantity on a free line (zero return value)", async () => {
    await render();
    // l1 is the zero-price line, so the return value stays 0: a change that
    // wrongly disabled zero-value returns must fail here (#229 finding 2)
    typeInto("supplier-return-qty-l1", "1");
    expect(previewAmount()).toBe(0);
    expect(confirmButton()?.disabled).toBe(false);
    // and the zero-value return is actually saved, not blocked at submit
    await submit();
    expect(submitted[0]).toMatchObject({ invoiceId: "inv-1", lines: [{ invoiceLineId: "l1", quantity: 1 }] });
  });

  it("rejects a fractional quantity instead of silently dropping it", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("treats a mark-only quantity as an untouched line: no draft error, confirm disabled (#244)", async () => {
    await render();
    // a bidi mark is Cf, not whitespace: the raw gate called it a chosen line
    // and showed the invalid-draft banner
    typeInto("supplier-return-qty-l2", "\u200f");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("drops a mark-only line while a valid line on the same form still submits (#244)", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1");
    typeInto("supplier-return-qty-l2", "\u200f");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).toBeNull();
    expect(confirmButton()?.disabled).toBe(false);
    await submit();
    expect(submitted[0]).toMatchObject({ invoiceId: "inv-1", lines: [{ invoiceLineId: "l1", quantity: 1 }] });
  });

  it("previews and saves the same Arabic-Indic quantity draft (#210)", async () => {
    await render();
    // l2 is the priced line, so a miscounted quantity shows up in the money
    typeInto("supplier-return-qty-l2", "٥");
    expect(previewAmount()).toBe(2000);
    // submit the SAME draft that was previewed: swapping to ASCII first would
    // pass even if saving stopped reading Arabic digits (#229 finding 1)
    await submit();
    expect(submitted[0]).toMatchObject({ lines: [{ invoiceLineId: "l2", quantity: 5 }] });
  });

  it("previews zero for a draft the submit path refuses, never a value it will not send (#210)", async () => {
    await render();
    // l2 is the priced line, so the pre-#210 loose reader renders 400000
    // (`1e3`) / 600 (`1.5`) instead of 0: only exact preview values pin it
    typeInto("supplier-return-qty-l2", "1e3");
    expect(previewAmount()).toBe(0);
    typeInto("supplier-return-qty-l2", "1.5");
    expect(previewAmount()).toBe(0);
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("accepts an Arabic-Indic quantity on the free-standing path (#210)", async () => {
    await render();
    await openSelect("supplier-return-mode", "بدون فاتورة");
    await openSelect("supplier-return-item", "هدية");
    typeInto("supplier-return-quantity", "٥");
    typeInto("supplier-return-amount", "300");
    await submit();
    expect(submitted[0]).toMatchObject({ supplierId: "sup-1", itemId: "item-1", quantity: 5, amount: 300 });
  });

  it("submits an Arabic-Indic free-standing amount as the same number as ASCII (#225)", async () => {
    await render();
    await openSelect("supplier-return-mode", "بدون فاتورة");
    await openSelect("supplier-return-item", "هدية");
    typeInto("supplier-return-quantity", "5");
    // the amount reader stays loose (`Number`), now digit-normalised: ٣٠٠ is 300,
    // exactly what the ASCII twin above submits
    typeInto("supplier-return-amount", "٣٠٠");
    await submit();
    expect(submitted[0]).toMatchObject({ supplierId: "sup-1", itemId: "item-1", quantity: 5, amount: 300 });
  });

  it("submits an Extended Arabic-Indic free-standing amount as the same number too (#225)", async () => {
    await render();
    await openSelect("supplier-return-mode", "بدون فاتورة");
    await openSelect("supplier-return-item", "هدية");
    // Extended Arabic-Indic (U+06F0..U+06F9) on both the quantity and the amount
    typeInto("supplier-return-quantity", "۵");
    typeInto("supplier-return-amount", "۳۰۰");
    await submit();
    expect(submitted[0]).toMatchObject({ supplierId: "sup-1", itemId: "item-1", quantity: 5, amount: 300 });
  });

  it("rejects a malformed cash-back instead of omitting the refund", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1");
    typeInto("supplier-return-cash", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("submits exactly the selected line and the parsed cash-back", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "2");
    typeInto("supplier-return-cash", "100");
    await submit();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      supplierId: "sup-1",
      invoiceId: "inv-1",
      lines: [{ invoiceLineId: "l1", quantity: 2 }],
      cashBack: 100,
    });
    // the success path must finish: refresh() ran, so onDone fired and no error
    // is shown (a missing itemsAll queryKey used to swallow this)
    expect(host.querySelector('[data-testid="supplier-return-error"]')).toBeNull();
    expect(doneCalls).toHaveLength(1);
  });

  it("clears a hidden invoice quantity error after switching to free-standing, then submits (round-2 finding)", async () => {
    await render();
    typeInto("supplier-return-qty-l1", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();

    await openSelect("supplier-return-mode", "بدون فاتورة");
    // the hidden invoice draft must no longer warn in free-standing mode
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).toBeNull();

    await openSelect("supplier-return-item", "هدية");
    typeInto("supplier-return-quantity", "2");
    typeInto("supplier-return-amount", "300");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).toBeNull();

    await submit();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ supplierId: "sup-1", itemId: "item-1", quantity: 2, amount: 300 });
    expect(host.querySelector('[data-testid="supplier-return-error"]')).toBeNull();
    expect(doneCalls).toHaveLength(1);
  });

  it("still shows a bad cash-back error in free-standing (shared check)", async () => {
    await render();
    await openSelect("supplier-return-mode", "بدون فاتورة");
    typeInto("supplier-return-cash", "1.5");
    expect(host.querySelector('[data-testid="supplier-return-draft-error"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("supplier return default refund method (#256)", () => {
  const defaultNote = () => host.querySelector('[data-testid="supplier-return-cash-default"]')?.textContent ?? "";

  it("says the default applies against the debt while the shop owes the supplier", async () => {
    await render(-1_500);
    typeInto("supplier-return-qty-l2", "1");
    // #260 — a NEGATIVE balance means the SHOP owes the supplier, so the copy
    // must name the debt on OUR side (finding #256 round 3: «لنا عند المورّد»
    // described money the supplier owes us — the opposite direction of the
    // money that moves)
    expect(defaultNote()).toContain("يُخصم من الدين");
    expect(defaultNote()).toContain("الدين الذي علينا للمورّد");
    expect(defaultNote()).not.toContain("لنا عند المورّد");
    // untouched: no cashBack is sent, so the server derives it from the ledger
    await submit();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.cashBack).toBeUndefined();
  });

  it("says the default comes back as cash when nothing is owed either way", async () => {
    await render(0);
    typeInto("supplier-return-qty-l2", "1");
    expect(previewAmount()).toBe(400);
    // the note names the amount the server will hand back by default
    expect(defaultNote()).toContain("استرجاع 400 دج نقداً");
    await submit();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.cashBack).toBeUndefined();
  });

  it("keeps an explicit zero cash-back as the owner's own answer", async () => {
    await render(0);
    typeInto("supplier-return-qty-l2", "1");
    typeInto("supplier-return-cash", "0");
    // the hint steps aside once the owner names the amount
    expect(host.querySelector('[data-testid="supplier-return-cash-default"]')).toBeNull();
    await submit();
    expect(submitted[0]?.cashBack).toBe(0);
  });
});
