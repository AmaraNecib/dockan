import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { normalizeTextKey } from "@dokan/contracts";

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
  expectedSupplierId?: string | null;
};

type ResolvedSupplier = { id: string; name: string; accountEntryCount: number };

let captured: { rows: CapturedRow[] } | null = null;
/** when true, the first unconfirmed save is refused as if the cached entry
 * count were stale */
let rejectUnconfirmed = false;
/** when true, the next save is refused even when confirmed (a stale confirmed
 * attempt) */
let rejectOnce = false;
/** the server's answer for `suppliersResolveName`, keyed by normalized name.
 * The page must render this verbatim (issue 184). */
let resolveByKey = new Map<string, ResolvedSupplier>();
/** when set, the unconfirmed refusal models a raced account: the server gains
 * the name, so the next resolve answers with this destination */
let racedAfterRefusal: { key: string; supplier: ResolvedSupplier } | null = null;
const BASE_SUPPLIERS = [
  { id: "s-1", name: "مورد له حركات", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 1, totalAmount: 5000, paidAmount: 0, remainingAmount: 5000 }, accountBalance: 5000, accountEntryCount: 3 },
  { id: "s-2", name: "مورد بلا حركات", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: 0, accountEntryCount: 0 },
  { id: "s-3", name: "مورد رصيد سالب", phone: null, createdAt: "2026-01-01T10:00:00", stats: { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 }, accountBalance: -300, accountEntryCount: 1 },
];
let suppliers = BASE_SUPPLIERS;
/** when true, the next resolve rejects (a failed read) */
let resolveFails = false;
/** count of resolve calls, to assert a no-op path never asks the server */
let resolveCalls = 0;
/** count of opening-balance writes the mock was asked to perform, whatever branch */
let mutationCalls = 0;
/** when true, the next save is refused as a stale named destination */
let rejectTargetChanged = false;
/** when set, the resolve waits on this promise before answering, so a test can
 * cancel while the lookup is still pending (review round 1 finding 1) */
let resolveHold: Promise<void> | null = null;
let releaseResolveHold: (() => void) | null = null;
/** when set, an opening-balance write parks until released (review round 1 follow-up) */
let mutationHold: Promise<void> | null = null;
let releaseMutationHold: (() => void) | null = null;

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
          mutationCalls += 1;
          if (mutationHold !== null) await mutationHold;
          if (rejectTargetChanged) {
            rejectTargetChanged = false;
            if (racedAfterRefusal !== null) resolveByKey.set(racedAfterRefusal.key, racedAfterRefusal.supplier);
            throw new Error("OPENING_BALANCE_TARGET_CHANGED");
          }
          if (rejectUnconfirmed && !input.rows.every((row) => row.confirmExisting === true)) {
            if (racedAfterRefusal !== null) resolveByKey.set(racedAfterRefusal.key, racedAfterRefusal.supplier);
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
    suppliersResolveName: {
      queryOptions: ({ input }: { input: { name: string; direction: string; amount: number; occurredAt: string; reason?: string } }) => ({
        queryKey: ["suppliersResolveName", input.name, input.direction, input.amount, input.occurredAt, input.reason ?? ""],
        queryFn: async () => {
          resolveCalls += 1;
          if (resolveFails) throw new Error("NETWORK");
          if (resolveHold !== null) await resolveHold;
          return { supplier: resolveByKey.get(normalizeTextKey(input.name)) ?? null };
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
  resolveFails = false;
  resolveCalls = 0;
  mutationCalls = 0;
  rejectTargetChanged = false;
  resolveHold = null;
  releaseResolveHold = null;
  mutationHold = null;
  releaseMutationHold = null;
  resolveByKey = new Map([[normalizeTextKey("مورد له حركات"), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 }]]);
  racedAfterRefusal = null;
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

/** happy-dom's native value setter; assigning `.value` directly does not notify
 * React, so tests must go through this. */
function setNativeValue(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("happy-dom exposes no native input value setter");
  setter.call(el, text);
}

function setInput(el: HTMLInputElement, text: string) {
  act(() => {
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Fill many controlled amount inputs in a single React render.
 *
 * A real DOM `input` event is a React *discrete* event, which React flushes
 * synchronously. Filling 200 rows that way re-renders the 200+ row table 200
 * times — the load-sensitive cost behind #193 (~15 s isolated, and a 60 s
 * timeout under contention, reproduced). Invoking each input's React change
 * handler inside one `act` lets React batch all 200 updates into one render
 * while still running the page's real `setRow` handler. `valueFor` receives the
 * input's index so a caller can give each row a distinct amount. If React's
 * props binding is absent (a future rename), this degrades to a real DOM event:
 * correct, just slow.
 */
function fillAmounts(inputs: readonly HTMLInputElement[], valueFor: (index: number) => string): void {
  act(() => {
    inputs.forEach((input, index) => {
      setNativeValue(input, valueFor(index));
      const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
      // SAFETY: React stores the element's props bag under `__reactProps$…`;
      // the single widening cast just reaches it, and the page's handler reads
      // only event.target.value, which is this input
      const props = propsKey === undefined ? undefined : (input as HTMLInputElement & Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey];
      if (props?.onChange === undefined) {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      props.onChange({ target: input });
    });
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

/**
 * #193 — the two batch-limit cases below fill every row of a 200+ row table,
 * so they carry an explicit budget. This is a safety net, not a load-sensitive
 * wait: the fills are batched into one render (see `fillAmounts`), so each test
 * costs ~1-2 s of CPU and 60 s leaves >20x headroom even on a contended turbo
 * run. If one of these ever times out again, fix the cost — do not raise it.
 */
const BATCH_LIMIT_TEST_TIMEOUT_MS = 60_000;

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
    // the server answered null (new supplier): the named destination is "create"
    expect(captured?.rows[1]?.expectedSupplierId).toBeNull();
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

  it("renders a credit current balance with its direction and keeps a typed name inline (issue 176 / round 5)", async () => {
    render();
    await settle();

    const rows = host.querySelectorAll('[data-testid="opening-balance-row"]');
    const creditCell = rows[2]?.querySelector('[data-testid="opening-balance-current"]')?.textContent ?? "";
    expect(creditCell).toContain("300");
    expect(creditCell).toContain("يسالنا");

    // a typed name is its own row: it is never moved onto an existing row
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    expect(rows[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')?.value).toBe("500");
  });

  it("surfaces the confirmation dialog when the server refuses a stale-expectation row (round 5)", async () => {
    rejectUnconfirmed = true;
    render();
    await settle();
    // the cached list says this supplier has no entries, but the server disagrees
    typeIntoRow(1, "200");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // the refusal refreshes the counts: the supplier really does have history
    suppliers = BASE_SUPPLIERS.map((supplier) => (supplier.id === "s-2" ? { ...supplier, accountEntryCount: 2 } : supplier));
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersList"] });
    });
    await settle();

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
    // batched into one render for the same #193 reason as the round-5 case below
    fillAmounts(Array.from(inputs), (index) => String(index + 1));
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد إضافي");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "1");

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);

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

  it("sends a typed name as newSupplierName with the named id as a consistency check (round 5 / #184)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;

    // the typed name matches s-1, but the draft stays inline (no row move)
    setInput(nameInput, "مورد له حركات");
    setInput(amountInput, "500");
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("");
    expect(amountInput.value).toBe("500");

    // s-1 has entries, so the dialog asks; confirming posts the NAME plus the
    // server-named id, which the write only uses to detect drift
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: "مورد له حركات", direction: "WE_OWE", amount: 500, confirmExisting: true, expectedSupplierId: "s-1" });
  });

  it("blocks a typed name that resolves to an already-picked supplier, even when the names differ (#184)", async () => {
    // the server folds a different-looking name onto s-1, which row 0 already targets
    resolveByKey.set(normalizeTextKey("اسم مختلف"), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    render();
    await settle();
    typeIntoRow(0, "700");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");

    // the folded names differ, so the local banner cannot see it; the submit
    // still refuses to send two rows to one account
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
  });

  it("re-blocks the open dialog when a row is edited onto the named account (#184)", async () => {
    // the dialog will name s-1 for this differently-spelled name
    resolveByKey.set(normalizeTextKey("اسم مختلف"), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // the owner edits row 0 (s-1) while the dialog is open: the resolved-id
    // conflict is visible again and must stop the confirm from posting two rows
    // to the account the dialog named once
    await act(async () => {
      typeIntoRow(0, "700");
    });
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured).toBeNull();
    // the conflict is visible again (banner) and the confirm button is disabled
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-confirm-save"]')?.disabled).toBe(true);
  });

  it("drops the dialog destination on cancel so it cannot block a later name (#184)", async () => {
    resolveByKey.set(normalizeTextKey("اسم مختلف"), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    render();
    await settle();
    const nameField = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    setInput(nameField, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    await act(async () => {
      clickOn("opening-balance-confirm-cancel");
    });

    // a new name plus a row for s-1: the cancelled dialog's destination must not
    // linger and report a false conflict
    setInput(nameField, "مورد جديد تماما");
    await act(async () => {
      typeIntoRow(0, "700");
    });
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).toBeNull();
  });

  it("writes nothing and surfaces the error when the resolve read fails (#184)", async () => {
    resolveFails = true;
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).not.toBeNull();
    // resolving was reset in `finally`, so the owner can retry
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);
  });

  it("re-resolves and re-opens the dialog when the named destination moved (#184)", async () => {
    const typed = "مورد انزاح";
    resolveByKey.set(normalizeTextKey(typed), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    rejectTargetChanged = true;
    // the refusal reveals the drifted account
    racedAfterRefusal = { key: normalizeTextKey(typed), supplier: { id: "s-moved", name: "مورد بديل", accountEntryCount: 4 } };
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    const confirmNames = () => Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
    expect(confirmNames()).toContain("مورد له حركات");

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured).toBeNull();
    // the dialog re-opened naming the moved account, never the stale one
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    expect(confirmNames()).toContain("مورد بديل");
    expect(confirmNames()).not.toContain("مورد له حركات");
  });

  it("does not write when the owner cancels while the lookup is pending (review round 1 finding 1)", async () => {
    // a new supplier with no rows filled: without the guard the late resolve
    // reaches save(false, null) and posts the balance after Cancel
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد جديد تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured).toBeNull();

    // leave while the lookup is still running
    await act(async () => {
      clickOn("opening-balance-cancel");
    });

    // the lookup finally answers: the abandoned attempt must not write
    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    expect(host.querySelector('[data-testid="opening-balance-saved"]')).toBeNull();
    // the lookup did run; only its result was ignored
    expect(resolveCalls).toBe(1);
  });

  it("does not re-open the dialog when its own cancel lands while a re-submit's lookup is pending (review round 2 finding 1)", async () => {
    // the typed name resolves to an account with entries, so the first submit
    // opens the confirmation dialog instead of writing directly
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    expect(mutationCalls).toBe(0);
    expect(resolveCalls).toBe(1);

    // a second main Save starts a NEW lookup for the same fields; hold it open
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(resolveCalls).toBe(2);

    // the dialog's OWN Cancel lands while that lookup runs
    await act(async () => {
      clickOn("opening-balance-confirm-cancel");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();

    // the held lookup settles: the dismissed dialog must not re-open and nothing
    // may be written by the abandoned attempt
    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
  });

  it("disables the confirm button while a re-submit's lookup is pending (review round 2)", async () => {
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    const confirmSave = () => host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-confirm-save"]');
    expect(confirmSave()?.disabled).toBe(false);

    // a second main Save puts a lookup in flight: the dialog must not be
    // confirmable against the snapshot that lookup is still deciding
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(confirmSave()?.disabled).toBe(true);

    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(confirmSave()?.disabled).toBe(false);
  });

  it("cancels the open confirmation on Escape (review round 2 / web interface guidelines)", async () => {
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // Escape from a button inside the dialog is the keyboard equivalent of Cancel
    const confirmSave = host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-confirm-save"]')!;
    await act(async () => {
      confirmSave.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
  });

  it("does not write when the page unmounts while the lookup is pending (review round 1 finding 1)", async () => {
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد إغلاق تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });

    // leave by unmounting (browser back / a route change) rather than the button
    act(() => root!.unmount());
    root = null;
    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    expect(resolveCalls).toBe(1);
  });

  it("abandons a pending save when an existing row changes before the lookup answers (review round 1 finding 1 follow-up)", async () => {
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد جديد تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");
    await act(async () => {
      clickOn("opening-balance-save");
    });

    // the owner fills an existing row while the lookup is running: the submit was
    // for the previous batch, so it must not write a batch missing this row
    await act(async () => {
      typeIntoRow(1, "500");
    });
    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);

    // the owner can recover: the corrected batch saves in full
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows.find((row) => row.supplierId === "s-2")).toMatchObject({ amount: 500 });
    expect(captured?.rows.find((row) => row.newSupplierName === "مورد جديد تماما")).toMatchObject({ amount: 300 });
  });

  it("abandons a pending save when a typed lookup field changes before the lookup answers (review round 1 finding 2 follow-up)", async () => {
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد ميدان تماما");
    setInput(amountInput, "300");
    await act(async () => {
      clickOn("opening-balance-save");
    });

    // the owner changes the amount while the lookup for the old amount runs
    setInput(amountInput, "450");
    await act(async () => {
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    expect(resolveCalls).toBe(1);
  });

  it("re-aligns the dialog after a refusal even when a row edit landed during the write (review round 1 follow-up)", async () => {
    const typed = "مورد انزاح كتابة";
    resolveByKey.set(normalizeTextKey(typed), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    rejectTargetChanged = true;
    racedAfterRefusal = { key: normalizeTextKey(typed), supplier: { id: "s-moved", name: "مورد بديل", accountEntryCount: 4 } };
    mutationHold = new Promise((resolve) => {
      releaseMutationHold = resolve;
    });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    const names = () => Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
    expect(names()).toContain("مورد له حركات");

    // the confirmed write parks; a row edit lands while it is in flight
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    await act(async () => {
      typeIntoRow(1, "250");
    });
    await act(async () => {
      releaseMutationHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    // the refusal still re-aligns the dialog to the moved account, never a stale one
    expect(captured).toBeNull();
    expect(names()).toContain("مورد بديل");
    expect(names()).not.toContain("مورد له حركات");
  });

  it("refuses to confirm an empty batch after the last confirmed row is cleared (review round 1 finding 2 follow-up)", async () => {
    render();
    await settle();
    typeIntoRow(0, "800"); // s-1 has entries -> the dialog opens
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // clear the only filled row: the dialog no longer names an account
    await act(async () => {
      typeIntoRow(0, "");
    });
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')).not.toBeNull();
  });

  it("lets a valid batch save after the typed name moves to another supplier (review round 1 finding 2)", async () => {
    resolveByKey.set(normalizeTextKey("مورد آخر"), { id: "s-9", name: "مورد آخر", accountEntryCount: 0 });
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!;
    setInput(nameInput, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    // the confirmation opens naming s-1
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // the owner edits the typed name to a DIFFERENT supplier while the dialog is
    // open, then fills s-1's existing row: the old destination must not block
    setInput(nameInput, "مورد آخر");
    await act(async () => {
      typeIntoRow(0, "700");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);

    // saving re-resolves the edited row and writes both accounts
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows.find((row) => row.supplierId === "s-1")).toMatchObject({ amount: 700, confirmExisting: true });
    expect(captured?.rows.find((row) => row.newSupplierName === "مورد آخر")).toMatchObject({ amount: 500, expectedSupplierId: "s-9" });
  });

  it("names the destination supplier in the confirmation dialog (round 5)", async () => {
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    // the dialog names the account the amount will land on
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')?.textContent).toContain("مورد له حركات");
    expect(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).toHaveLength(1);
  });

  it("renders the server-resolved destination name, not the typed text (issue 184)", async () => {
    // the server folds the typed text onto s-1 and answers with s-1's stored name
    const typed = "مورد   له حركات";
    resolveByKey.set(normalizeTextKey(typed), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 });
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "500");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    const names = Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent);
    expect(names).toEqual(["مورد له حركات"]);
    expect(names).not.toContain(typed);
  });

  it("blocks two outgoing rows folding to one name before the server (round 5)", async () => {
    render();
    await settle();
    // an explicit row for s-1 plus a typed name that folds to the same name
    typeIntoRow(0, "700");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد  له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "300");

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("does not cut off an owner still typing a new name that starts like an existing one (round 5)", async () => {
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

  it("submits a focused duplicate name on Enter instead of reporting nothing entered (round 5)", async () => {
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

  it("blocks a typed name whose supplier already has a filled row instead of double-posting (round 5)", async () => {
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

    // nothing is sent: one opening balance per supplier, never two entries. The
    // conflict is visible and blocks the save before any request.
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    clickOn("opening-balance-save");
    expect(captured).toBeNull();
  });

  it("names and confirms a raced named row only after the refusal refreshes it (round 5 / #184)", async () => {
    rejectUnconfirmed = true;
    const typedName = "مورد ظهر مرتين";
    // folds to the same key as the typed text, but is a different string: the
    // dialog must switch to the server's stored text after the refresh
    const racedName = "مورد  ظهر مرتين";
    racedAfterRefusal = { key: normalizeTextKey(typedName), supplier: { id: "s-raced2", name: racedName, accountEntryCount: 2 } };
    render();
    await settle();

    typeIntoRow(0, "800"); // s-1 has entries, so the batch needs confirmation
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, typedName);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!, "400");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    const confirmNames = () => Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    expect(confirmNames()).toContain(typedName);

    // the client still thinks the name is new, so the first confirm does not
    // forward confirmExisting; the server refuses and the catch re-asks for the
    // destination
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured).toBeNull();

    // the refused resolve now answers with the raced account: the dialog names
    // the server's text, not the typed string
    expect(confirmNames()).toContain(racedName);
    expect(confirmNames()).not.toContain(typedName);

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows.find((row) => row.supplierId === "s-1")).toMatchObject({ amount: 800, confirmExisting: true });
    expect(captured?.rows.find((row) => row.newSupplierName === typedName)).toMatchObject({ amount: 400, confirmExisting: true, expectedSupplierId: "s-raced2" });
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

  it("counts a typed name toward the batch limit and blocks before the server (round 5)", async () => {
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

    // fill the first 200 rows, leaving the 201st empty. Batched into one
    // render: 200 discrete input events would re-render the table 200 times
    // and make this test's wall-clock depend on host contention (#193).
    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(201);
    fillAmounts(Array.from(inputs).slice(0, 200), () => "1");

    // the typed name matches the 201st supplier, so the batch is 201 rows
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-amount"]')!;
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-new-name"]')!, "مورد 200");
    setInput(amountInput, "5");
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });

    // 200 filled + the resolved row is over the cap: the page blocks, never sends
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(captured).toBeNull();
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);
});
