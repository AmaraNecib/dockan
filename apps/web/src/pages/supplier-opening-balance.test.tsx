import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n";

import { routerMock } from "../tests/router-mock";

mock.module("@tanstack/react-router", () => routerMock());

type CapturedRow = {
  supplierId?: string;
  newSupplierName?: string;
  direction: "WE_OWE" | "THEY_OWE";
  amount: number;
  confirmExisting?: boolean;
};

let captured: { rows: CapturedRow[] } | null = null;
/** when true, the first unconfirmed save is refused as if the cached entry
 * count were stale */
let rejectUnconfirmed = false;
const BASE_SUPPLIERS = [
  { id: "s-1", name: "مورد له حركات", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 1, totalAmount: 5000, paidAmount: 0, remainingAmount: 5000 }, accountBalance: 5000, accountEntryCount: 3 },
  { id: "s-2", name: "مورد بلا حركات", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: 0, accountEntryCount: 0 },
  { id: "s-3", name: "مورد رصيد سالب", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: -300, accountEntryCount: 1 },
];
let suppliers = BASE_SUPPLIERS;

mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersList: {
      queryOptions: () => ({ queryKey: ["suppliersList"], queryFn: async () => ({ items: suppliers }) }),
      queryKey: () => ["suppliersList"],
    },
    suppliersOpeningBalances: {
      mutationOptions: () => ({
        mutationKey: ["suppliersOpeningBalances"],
        mutationFn: async (input: { rows: CapturedRow[] }) => {
          if (rejectUnconfirmed && !input.rows.every((row) => row.confirmExisting === true)) {
            throw new Error("OPENING_BALANCE_EXISTS");
          }
          captured = input;
          return { created: input.rows.length, accounts: input.rows.map((_row, index) => ({ supplierId: `s-${index}`, name: `مورد ${index}`, balance: 0 })) };
        },
      }),
    },
    reportsDebts: { queryKey: () => ["reportsDebts"] },
    dashboardSummary: { queryKey: () => ["dashboardSummary"] },
  },
  DEBTS_BY_PARTY_QUERY_KEY: [["debtsByParty"]],
  rpcClient: {},
}));

const { SupplierOpeningBalancePage } = await import("./supplier-opening-balance");

let host: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  captured = null;
  rejectUnconfirmed = false;
  suppliers = BASE_SUPPLIERS;
  queryClient = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = client;
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <SupplierOpeningBalancePage />
      </QueryClientProvider>,
    );
  });
}

/** Flush the suppliersList query so the rows exist before the test reads them. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInput(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function typeIntoRow(rowIndex: number, text: string) {
  const rows = host.querySelectorAll('[data-testid="opening-balance-row"]');
  const input = rows[rowIndex]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]');
  if (input === null || input === undefined) throw new Error(`missing amount input for row ${rowIndex}`);
  setInput(input, text);
}

function clickOn(testId: string) {
  const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  act(() => el.click());
}

/** Open the inline new-supplier direction Select and commit the labelled option. */
async function pickNewDirection(label: string) {
  const trigger = host.querySelector<HTMLElement>('[data-testid="opening-balance-new-direction"]');
  if (trigger === null) throw new Error("missing opening-balance-new-direction");
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const optionText = (element: HTMLElement) => (element.textContent ?? "").trim();
  for (let attempt = 0; attempt < 20; attempt++) {
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => optionText(element) === label);
    if (option !== undefined) {
      act(() => {
        // Base UI items arm mouse selection on pointerdown, then commit on click.
        option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
        option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
      });
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`option ${label} did not appear`);
}

describe("SupplierOpeningBalancePage (issue 176)", () => {
  it("writes one row per filled amount plus an inline new supplier", async () => {
    render();
    await settle();
    // row 0 (already has entries) stays empty; row 1 gets an amount
    typeIntoRow(1, "300");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد جملة");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "800");

    await act(async () => {
      clickOn("opening-balance-save");
    });

    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-2", direction: "WE_OWE", amount: 300 });
    expect(captured?.rows[0]?.confirmExisting).toBeUndefined();
    expect(captured?.rows[1]).toMatchObject({ newSupplierName: "مورد جملة", direction: "WE_OWE", amount: 800 });
  });

  it("asks for confirmation before adding an opening balance to a supplier that already has entries", async () => {
    render();
    await settle();
    typeIntoRow(0, "800");
    clickOn("opening-balance-save");
    // the first save only asks; nothing is written yet
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-1", amount: 800, confirmExisting: true });
  });

  it("refuses to save when no row carries an amount", async () => {
    render();
    await settle();
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')?.textContent).toContain("لم تُدخل");
  });

  it("renders a credit current balance with its direction and moves a duplicate inline name onto that supplier (issue 176 / Greptile round 2)", async () => {
    render();
    await settle();

    const rows = host.querySelectorAll('[data-testid="opening-balance-row"]');
    const creditCell = rows[2]?.querySelector('[data-testid="opening-balance-current"]')?.textContent ?? "";
    expect(creditCell).toContain("300");
    expect(creditCell).toContain("يسالنا");

    // typing an existing supplier's name moves the amount onto that supplier's
    // row instead of minting a second account
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    expect(host.querySelector('[data-testid="opening-balance-name-exists"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("500");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("");

    // s-1 already carries entries, so the save still asks before posting
    clickOn("opening-balance-save");
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
  });

  it("surfaces the confirmation dialog when the server refuses a stale-expectation row", async () => {
    rejectUnconfirmed = true;
    render();
    await settle();
    // the cached list says this supplier has no entries, but the server disagrees
    typeIntoRow(1, "200");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-2", confirmExisting: true });
  });

  it("keeps a grouped 1,000 amount instead of silently dropping its row (Greptile finding 1)", async () => {
    render();
    await settle();
    typeIntoRow(0, "1,000");
    typeIntoRow(1, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    // row 0 already carries entries, so the confirmation comes first
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });

    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows.find((row) => row.supplierId === "s-1")?.amount).toBe(1000);
    expect(captured?.rows.find((row) => row.supplierId === "s-2")?.amount).toBe(500);
  });

  it("blocks the save and marks the row when an amount draft is invalid (Greptile finding 1)", async () => {
    render();
    await settle();
    typeIntoRow(1, "abc");

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("rejects a decimal-grouped amount with a row error instead of saving 100x (Greptile round 2)", async () => {
    render();
    await settle();
    typeIntoRow(1, "1 000,00");

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("blocks an incomplete inline supplier instead of dropping it (Greptile finding 1)", async () => {
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورّد بلا مبلغ");

    expect(host.querySelector('[data-testid="opening-balance-new-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("blocks a batch over the 200-row contract limit before saving (Greptile finding 4)", async () => {
    suppliers = Array.from({ length: 200 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      phone: null,
      createdAt: "2026-01-01T10:00:00",
      stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 },
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(200);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      inputs.forEach((input, index) => {
        setter?.call(input, String(index + 1));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد إضافي");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "1");

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("invalidates the real debts and dashboard keys after saving (Greptile finding 5)", async () => {
    render();
    await settle();
    typeIntoRow(1, "300");
    const spy = spyOn(queryClient!, "invalidateQueries");

    await act(async () => {
      clickOn("opening-balance-save");
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["reportsDebts"]));
    expect(keys).toContain(JSON.stringify([["debtsByParty"]]));
    expect(keys).toContain(JSON.stringify(["dashboardSummary"]));
    expect(keys).toContain(JSON.stringify([["activitiesList"]]));
    expect(keys).toContain(JSON.stringify([["invoicesList"]]));
    expect(keys).not.toContain(JSON.stringify(["debtsData"]));
  });

  it("moves a typed name that raced into existence onto its existing row when confirmed (Greptile round 2)", async () => {
    rejectUnconfirmed = true;
    render();
    await settle();

    const name = "مورد ظهر للتو";
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, name);
    await pickNewDirection("يسالنا");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "640");

    // the first save reaches the server with the typed name as a new supplier
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    expect(captured).toBeNull();

    // the concurrent create lands: the refreshed list now shows the typed supplier
    // with account history, so the typed name is a duplicate
    suppliers = [
      ...BASE_SUPPLIERS,
      { id: "s-race", name, phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 1, totalAmount: 900, paidAmount: 0, remainingAmount: 900 }, accountBalance: 900, accountEntryCount: 2 },
    ];
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersList"] });
    });
    await settle();

    // the draft moved onto the existing supplier's row, preserving amount + direction
    const movedAmount = host.querySelectorAll('[data-testid="opening-balance-row"]')[3]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value;
    expect(movedAmount).toBe("640");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("");

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });

    // the confirmed save posts under the existing id, not a silent no-op
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-race", direction: "THEY_OWE", amount: 640, confirmExisting: true });
  });

  it("adopts a name that raced in before the save is pressed, so the save is never a dead end (Greptile round 2)", async () => {
    render();
    await settle();

    const name = "مورد سبق الحفظ";
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, name);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "250");

    // the concurrent create lands (a background refetch) before the owner saves
    suppliers = [
      ...BASE_SUPPLIERS,
      { id: "s-pre", name, phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 1, totalAmount: 900, paidAmount: 0, remainingAmount: 900 }, accountBalance: 900, accountEntryCount: 2 },
    ];
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersList"] });
    });
    await settle();

    // the draft moves and the save is not a disabled dead end
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[3]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("250");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-pre", direction: "WE_OWE", amount: 250, confirmExisting: true });
  });
});
