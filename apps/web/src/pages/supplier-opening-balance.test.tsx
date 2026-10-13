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
/** when true, the next save is refused even when confirmed (a stale confirmed
 * attempt) */
let rejectOnce = false;
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
          if (rejectOnce) {
            rejectOnce = false;
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
  rejectOnce = false;
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

    // the confirmed save posts the typed name, not a pre-resolved id
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: name, direction: "THEY_OWE", amount: 640, confirmExisting: true });
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
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: name, direction: "WE_OWE", amount: 250, confirmExisting: true });
  });

  it("does not cut off an owner still typing a new name that starts like an existing one (Greptile round 2)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;

    // amount first, then the owner focuses the name field and starts typing a
    // name whose prefix matches an existing supplier
    setInput(amountInput, "250");
    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, "مورد له حركات");

    // still focused: the draft has not moved, so the amount is intact
    expect(amountInput.value).toBe("250");
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("");

    // the owner finishes the intended NEW name (no longer matching)
    setInput(nameInput, "مورد له حركات 2");
    await act(async () => {
      nameInput.blur();
    });
    expect(amountInput.value).toBe("250");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: "مورد له حركات 2", direction: "WE_OWE", amount: 250 });
  });

  it("adopts only after the amount field blurs, never mid-keystroke (Greptile round 2)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;
    const matchedRowAmount = () => host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value;

    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, "مورد له حركات");
    await act(async () => {
      nameInput.blur();
      amountInput.focus();
    });

    // type the amount one digit at a time; the amount is focused, so nothing moves
    for (const draft of ["1", "15", "150", "1500"]) setInput(amountInput, draft);
    expect(amountInput.value).toBe("1500");
    expect(matchedRowAmount()).toBe("");

    // leaving the amount adopts the FULL value in one piece
    await act(async () => {
      amountInput.blur();
    });
    expect(matchedRowAmount()).toBe("1500");
    expect(amountInput.value).toBe("");
  });

  it("submits a focused duplicate name on Enter instead of reporting nothing entered (Greptile round 2)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    // the name field is still focused when the owner presses Enter: the row must
    // count as filled via the resolved supplier, not report "nothing entered"
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: "مورد له حركات", direction: "WE_OWE", amount: 500, confirmExisting: true });
  });

  it("blocks a typed name whose supplier already has a filled row instead of double-posting (Greptile round 2)", async () => {
    render();
    await settle();
    const rowAmount = () => host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value;

    typeIntoRow(0, "700");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");

    // the row keeps the owner's earlier 700; the inline draft is left for the
    // conflict guard to flag rather than clobbering or double-posting
    expect(rowAmount()).toBe("700");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("300");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    // nothing is sent: one opening balance per supplier, never two entries
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).not.toBeNull();
  });

  it("blocks two same-name rows adopted onto different siblings instead of sending both (Greptile round 4)", async () => {
    const name = "مورد مكرر";
    const twinA = { id: "twin-a", name, phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: 0, accountEntryCount: 0 };
    const twinB = { ...twinA, id: "twin-b", name: name.replace(" ", "  ") };
    suppliers = [twinA, twinB];
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;

    // the first typed name adopts onto the lowest-id twin
    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, name);
    await act(async () => {
      nameInput.blur();
      amountInput.focus();
    });
    setInput(amountInput, "100");
    await act(async () => {
      amountInput.blur();
    });

    // the refetch gives the OTHER twin more entries, so a second typed name would
    // resolve to it; the page must block, never emit two same-name rows
    suppliers = [twinA, { ...twinB, accountEntryCount: 3 }];
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersList"] });
    });
    await settle();

    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, name);
    await act(async () => {
      nameInput.blur();
      amountInput.focus();
    });
    setInput(amountInput, "200");
    await act(async () => {
      amountInput.blur();
    });

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).not.toBeNull();
  });

  it("resolves duplicate folded names to the entry-carrying supplier, like the server (Greptile round 2)", async () => {
    const name = "مورد ازدواج";
    // two suppliers fold to one normalizeTextKey; the server prefers the one
    // that already carries entries, then the lowest id
    suppliers = [
      { id: "s-empty-twin", name, phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: 0, accountEntryCount: 0 },
      { id: "s-carrying-twin", name: name.replace(" ", "  "), phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 1, totalAmount: 900, paidAmount: 0, remainingAmount: 900 }, accountBalance: 900, accountEntryCount: 2 },
    ];
    render();
    await settle();
    const rows = () => host.querySelectorAll('[data-testid="opening-balance-row"]');
    const rowAmount = (index: number) => rows()[index]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value;
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;

    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, name);
    await act(async () => {
      nameInput.blur();
      amountInput.focus();
    });
    setInput(amountInput, "500");
    await act(async () => {
      amountInput.blur();
    });

    expect(rowAmount(1)).toBe("500");
    expect(rowAmount(0)).toBe("");
  });

  it("forwards confirmExisting on a named row in a mixed confirmed batch (Greptile round 3)", async () => {
    rejectUnconfirmed = true;
    render();
    await settle();

    // s-1 already has entries, so the batch needs confirmation; the second row is
    // a typed name the client does not know the server already has
    typeIntoRow(0, "800");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد ظهر مرتين");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "400");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    // the named row must carry confirmExisting too, or the server refuses and
    // nothing in the mixed batch ever saves
    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-1", amount: 800, confirmExisting: true });
    expect(captured?.rows[1]).toMatchObject({ newSupplierName: "مورد ظهر مرتين", amount: 400, confirmExisting: true });
  });

  it("refreshes suppliers after a confirmed refusal too (Greptile round 3)", async () => {
    rejectOnce = true;
    render();
    await settle();
    typeIntoRow(0, "800");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    const spy = spyOn(queryClient!, "invalidateQueries");
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });

    // a refusal on the already-confirmed path must still refresh the list so the
    // page can recover instead of repeating the same refusal forever
    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["suppliersList"]));
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
  });

  it("does not overwrite an invalid target draft when adopting a typed name (Greptile round 3)", async () => {
    render();
    await settle();
    typeIntoRow(0, "1 000,00");
    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();

    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    // the invalid row keeps its text and its error; the inline draft stays for the
    // conflict guard rather than silently clobbering the bad value
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("1 000,00");
    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("500");
  });

  it("counts a resolved typed name toward the batch limit and blocks before the server (Greptile round 3)", async () => {
    suppliers = Array.from({ length: 201 }, (_value, index) => ({
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

    // fill the first 200 rows, leaving the 201st empty
    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(201);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      inputs.forEach((input, index) => {
        if (index >= 200) return;
        setter?.call(input, "1");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    // the typed name matches the 201st supplier; keep the amount focused so the
    // adoption effect cannot mask the resolved-row count
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد 200");
    await act(async () => {
      amountInput.focus();
    });
    setInput(amountInput, "5");
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });

    // 200 filled + the resolved row is over the cap: the page blocks, never sends
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(captured).toBeNull();
  }, 60_000);
});
