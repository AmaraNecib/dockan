import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { normalizeTextKey } from "@dokan/contracts";

// SAFETY: React 19 act() requires the environment flag to be set explicitly
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n";

import { routerMock } from "../tests/router-mock";
import { activateOption, chooseOption, findOption, openSelect } from "../tests/select-driver";

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
  { id: "s-1", name: "مورد له حركات", accountBalance: 5000, accountEntryCount: 3 },
  { id: "s-2", name: "مورد بلا حركات", accountBalance: 0, accountEntryCount: 0 },
  { id: "s-3", name: "مورد رصيد سالب", accountBalance: -300, accountEntryCount: 1 },
];
/** #207 — two suppliers with no account entries. The boundary reject tests use
 * these as their batch: with no supplier carrying entries, a dropped guard must
 * SEND the batch, so `captured === null` is discriminating on its own instead of
 * leaning on the confirmation precondition to swallow the write. */
const TWO_NO_ENTRY_SUPPLIERS = [
  { id: "s-a", name: "مورد أ", accountBalance: 0, accountEntryCount: 0 },
  { id: "s-b", name: "مورد ب", accountBalance: 0, accountEntryCount: 0 },
];
let suppliers = BASE_SUPPLIERS;
/** #183 — set when the page reads the full party list; it must never do so. */
let suppliersListUsed = false;
/** when true, the account summary read rejects */
let accountsShouldFail = false;
/** when true, the names-only read rejects */
let namesShouldFail = false;
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
/** when set, the names read waits on this promise, so a test can hold a reset
 * query's replacement read in flight (review round 5 finding 2) */
let namesHold: Promise<void> | null = null;
let releaseNamesHold: (() => void) | null = null;
/** when set, an opening-balance write parks until released (review round 1 follow-up) */
let mutationHold: Promise<void> | null = null;
let releaseMutationHold: (() => void) | null = null;

// #183 — the page reads two lean seams: names-only (the conflict-check list)
// and the supplier account summary (the balance/entry columns). The mock mirrors
// the server: the summary omits suppliers with no entry, and the page defaults
// a missing id to 0/0. The full `suppliersList` seam is still mocked, but only to
// prove the page never touches it.
mock.module("@/lib/rpc", () => ({
  orpc: {
    suppliersList: {
      queryOptions: () => {
        suppliersListUsed = true;
        return { queryKey: ["suppliersList"], queryFn: async () => ({ items: suppliers }) };
      },
      queryKey: () => ["suppliersList"],
    },
    suppliersListNames: {
      queryOptions: () => ({
        queryKey: ["suppliersListNames"],
        queryFn: async () => {
          if (namesShouldFail) throw new Error("NAMES_FAILED");
          if (namesHold !== null) await namesHold;
          return { items: suppliers.map(({ id, name }) => ({ id, name })) };
        },
      }),
      queryKey: () => ["suppliersListNames"],
    },
    suppliersAccountSummaries: {
      queryOptions: () => ({
        queryKey: ["suppliersAccountSummaries"],
        queryFn: async () => {
          if (accountsShouldFail) throw new Error("ACCOUNT_SUMMARY_FAILED");
          return { items: suppliers.filter((supplier) => supplier.accountEntryCount > 0).map(({ id, accountBalance, accountEntryCount }) => ({ id, accountBalance, accountEntryCount })) };
        },
      }),
      queryKey: () => ["suppliersAccountSummaries"],
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
    // #255 — the page resolves a whole typed draft in ONE call. The mock counts
    // resolve PASSES (`resolveCalls`), so a per-row regression reads as N here.
    suppliersResolveNames: {
      queryOptions: ({ input }: { input: { occurredAt: string; reason?: string; rows: Array<{ name: string; direction: string; amount: number }> } }) => ({
        queryKey: ["suppliersResolveNames", input.occurredAt, input.reason ?? "", ...input.rows.map((row) => `${row.name}|${row.direction}|${row.amount}`)],
        queryFn: async () => {
          resolveCalls += 1;
          if (resolveFails) throw new Error("NETWORK");
          if (resolveHold !== null) await resolveHold;
          return { suppliers: input.rows.map((row) => resolveByKey.get(normalizeTextKey(row.name)) ?? null) };
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
  namesHold = null;
  releaseNamesHold = null;
  mutationHold = null;
  releaseMutationHold = null;
  resolveByKey = new Map([[normalizeTextKey("مورد له حركات"), { id: "s-1", name: "مورد له حركات", accountEntryCount: 3 }]]);
  racedAfterRefusal = null;
  suppliers = BASE_SUPPLIERS;
  suppliersListUsed = false;
  accountsShouldFail = false;
  namesShouldFail = false;
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

/** Flush the two supplier reads so the rows exist before the test reads them. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

/** Find a test-id element or fail loudly; one place so every click helper shares
 * the same null handling. */
function clickTarget<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = host.querySelector<T>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`missing ${testId}`);
  return el;
}

/**
 * #193 — the two batch-limit cases below fill every row of a 200+ row table,
 * so they carry an explicit budget. This is a safety net, not a load-sensitive
 * wait: the fills are batched into one render (see `fillAmounts`), so each test
 * costs ~1-2 s of CPU and 60 s leaves >20x headroom even on a contended turbo
 * run. If one of these ever times out again, fix the cost — do not raise it.
 */
const BATCH_LIMIT_TEST_TIMEOUT_MS = 60_000;

function clickOn(testId: string) {
  act(() => clickTarget(testId).click());
}

/** Dispatch a click carrying explicit mouse flags on a test-id element. A plain
 * `.click()` cannot express a Ctrl/Cmd-click (which the browser turns into a new
 * tab) or a non-primary button, so the new-tab tests use this. */
function dispatchClickOn(testId: string, init: MouseEventInit) {
  act(() => clickTarget(testId).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
}

/**
 * #207 — the scaffold the #203 conversions share, in one place.
 *
 * A test that asserts "nothing was sent" passes for the wrong reason unless a
 * valid batch exists that WOULD be sent once the guard under test is removed.
 * Two unrelated guards used to mask those assertions: the empty-batch check and
 * the confirmation precondition. One valid row for row 1 defeats both: in the
 * default fixture that row is s-2, and in TWO_NO_ENTRY_SUPPLIERS it is s-b, both
 * with no account entries. It keeps `totalRows > 0`, and its supplier has no
 * entries, so no confirmation dialog can swallow the submit.
 *
 * `arm` then builds the failure under test; it may be async because the
 * read-failure cases refetch and `settle()` first. The form is submitted through
 * `requestSubmit()`, never `clickOn("opening-balance-save")`: the save control is
 * disabled exactly where these tests live, React swallows a click on a disabled
 * control, and the request would never run.
 *
 * `validRowAmount: null` skips the default row for a test that builds its whole
 * valid batch in `arm` (the over-limit cases, or a valid typed-name row); those
 * still get the drift-prone half, the submit itself. The default row is row 1,
 * whose supplier carries no entries in every fixture this file uses; a fixture
 * with entries on row 1 would open the confirmation dialog instead of sending,
 * so keep that invariant when adding callers. Reject-side assertions stay in the
 * test body afterwards (a blocked submit leaves the visible state unchanged); an
 * accept-side test may assert the enabled control from inside `arm`, before the
 * submit.
 */
async function submitForm(arm: () => void | Promise<void>, validRowAmount: string | null = "300"): Promise<void> {
  if (validRowAmount !== null) typeIntoRow(1, validRowAmount);
  await arm();
  await act(async () => {
    host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
  });
}

/** Render, type a supplier that already carries entries, open the confirmation,
 * then refuse the confirmed save as a stale destination and park the recovery
 * lookup that refusal starts. Callers decide which gesture lands while the lookup
 * is held and assert after releasing it via the module-level `releaseResolveHold`.
 * The synchronous act + microtask flush for the refused save is deliberate:
 * `await act(async ...)` deadlocks on the held resolve promise (review round 3 T4). */
async function openConfirmWithRefusedSaveHeld() {
  render();
  await settle();
  setInput(clickTarget<HTMLInputElement>("opening-balance-typed-name-0"), "مورد له حركات");
  setInput(clickTarget<HTMLInputElement>("opening-balance-typed-amount-0"), "500");
  await act(async () => {
    clickOn("opening-balance-save");
  });
  expect(clickTarget("opening-balance-confirm")).not.toBeNull();

  rejectTargetChanged = true;
  racedAfterRefusal = { key: normalizeTextKey("مورد له حركات"), supplier: { id: "s-moved", name: "مورد بديل", accountEntryCount: 4 } };
  resolveHold = new Promise((resolve) => {
    releaseResolveHold = resolve;
  });
  act(() => {
    clickOn("opening-balance-confirm-save");
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(clickTarget("opening-balance-confirm")).not.toBeNull();
}

/** Release the lookup `openConfirmWithRefusedSaveHeld` parked and let its
 * continuation flush. */
async function releaseHeldRecovery() {
  await act(async () => {
    releaseResolveHold?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

/** Every activation a browser turns into a NEW tab rather than a current-tab
 * navigation. One case per predicate term, so dropping any of `!metaKey`,
 * `!shiftKey`, `!altKey`, or `button === 0` fails a test. `button: 1` is
 * synthetic here — real browsers emit `auxclick`, which React's onClick never
 * sees — but it still pins the predicate's button term. */
const NEW_TAB_ACTIVATIONS: Array<[string, MouseEventInit]> = [
  ["Ctrl-click", { ctrlKey: true }],
  ["Cmd-click", { metaKey: true }],
  ["Shift-click", { shiftKey: true }],
  ["Alt-click", { altKey: true }],
  ["middle-click", { button: 1 }],
];

describe("SupplierOpeningBalancePage (issue 176)", () => {
  it("writes one row per filled amount plus an inline new supplier", async () => {
    render();
    await settle();
    // row 0 (already has entries) stays empty; row 1 gets an amount
    typeIntoRow(1, "300");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد جملة");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "800");

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

  it("renders each current balance with its direction and keeps a typed name inline (issue 176 / round 5 / #260)", async () => {
    render();
    await settle();

    const rows = host.querySelectorAll('[data-testid="opening-balance-row"]');
    // #260 — s-3 is −300, a debt: the word is يسالنا
    const debtCell = rows[2]?.querySelector('[data-testid="opening-balance-current"]')?.textContent ?? "";
    expect(debtCell).toContain("300");
    expect(debtCell).toContain("يسالنا");
    // #260 — s-1 is +5000, a credit: the word is نسالوه
    const positiveCell = rows[0]?.querySelector('[data-testid="opening-balance-current"]')?.textContent ?? "";
    expect(positiveCell).toContain("5,000");
    expect(positiveCell).toContain("نسالوه");

    // a typed name is its own row: it is never moved onto an existing row
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
    expect(rows[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')?.value).toBe("500");
  });

  /**
   * #252 — the direction control's label-to-VALUE binding.
   *
   * Two defects met on this control: the i18n map carried each Darija on the
   * other enum value, and `SelectValue` had no `items` map on the root, so the
   * trigger printed the raw `WE_OWE` (Base UI falls back to the value string).
   * The old tests could not see either: the only direction assertion found a
   * disabled button, and no test ever read this trigger.
   *
   * This asserts the string on the trigger is the "we owe him" Darija, and that
   * clicking the "he owes us" option submits THEY_OWE — the same click a
   * shopkeeper makes when the supplier owes HIM. The value is what must match the
   * label, not the label matching a stale expectation.
   */
  it("#252 — the direction select reads the Darija label, never the raw enum, and submits the value its label names", async () => {
    render();
    await settle();

    const rowTrigger = clickTarget("opening-balance-direction");
    const newTrigger = clickTarget("opening-balance-typed-direction-0");
    // the trigger also carries the chevron icon; the label lives in the SelectValue
    // span, the element Base UI resolves from the root's `items` map
    const labelOf = (trigger: Element) => trigger.querySelector('[data-slot="select-value"]')?.textContent;
    for (const trigger of [rowTrigger, newTrigger]) {
      expect(labelOf(trigger)).toBe("يسالنا");
      expect(labelOf(trigger)).not.toContain("WE_OWE");
      expect(labelOf(trigger)).not.toContain("THEY_OWE");
    }

    // the popup offers the same two strings the root's map holds, in value order:
    // list and trigger read one map, so they cannot disagree about which label sits
    // on which value
    await openSelect(newTrigger);
    const listboxId = newTrigger.getAttribute("aria-controls") ?? "";
    const optionLabels = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"))
      .filter((option) => option.closest("[role='listbox']")?.id === listboxId)
      .map((option) => option.textContent?.trim() ?? "");
    expect(optionLabels).toEqual(["يسالنا", "نسالوه"]);

    // choosing the option that reads "he owes us" (THEY_OWE) must submit THEY_OWE
    const theyOweOption = await findOption("نسالوه", newTrigger);
    expect(theyOweOption).not.toBeNull();
    await activateOption(theyOweOption!);
    expect(labelOf(newTrigger)).toBe("نسالوه");

    setInput(clickTarget("opening-balance-typed-name-0"), "مورد اتجاه ٢٥٢");
    setInput(clickTarget("opening-balance-typed-amount-0"), "700");
    await act(async () => {
      clickOn("opening-balance-save");
    });

    expect(captured?.rows[0]).toMatchObject({ newSupplierName: "مورد اتجاه ٢٥٢", direction: "THEY_OWE", amount: 700 });
  });

  /** The other half of acceptance 2 on this screen: the option that reads «يسالنا»
   * (WE_OWE = we owe him) must SUBMIT WE_OWE. Moved off the default first, so an
   * option that leaves the draft untouched cannot pass. */
  it("#252 — choosing the 'we owe him' option submits WE_OWE", async () => {
    render();
    await settle();

    // row 1 is s-2, which carries no account entries, so the save goes straight
    // through without the confirmation dialog
    const trigger = host.querySelectorAll<HTMLElement>('[data-testid="opening-balance-direction"]')[1]!;
    const labelOf = () => trigger.querySelector('[data-slot="select-value"]')?.textContent;
    await chooseOption(trigger, "نسالوه");
    expect(labelOf()).toBe("نسالوه");
    await chooseOption(trigger, "يسالنا");
    expect(labelOf()).toBe("يسالنا");

    typeIntoRow(1, "450");
    await act(async () => {
      clickOn("opening-balance-save");
    });

    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-2", direction: "WE_OWE", amount: 450 });
  });

  it("surfaces the confirmation dialog when the server refuses a stale-expectation row (round 5)", async () => {
    rejectUnconfirmed = true;
    render();
    await settle();
    // the cached list says this supplier has no entries, but the server disagrees
    typeIntoRow(1, "200");
    // the server has already recorded history the cached account summary does not
    // show. The page's OWN refusal handler must refresh the counts; the test never
    // invalidates them, so a page that skips the account refresh keeps s-2 at 0
    // entries and the confirmed save would not forward confirmExisting.
    suppliers = BASE_SUPPLIERS.map((supplier) => (supplier.id === "s-2" ? { ...supplier, accountEntryCount: 2 } : supplier));
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    await settle();

    // the refusal's own refresh surfaced the history: the dialog names the
    // supplier, and the confirmed save carries confirmExisting for it
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')?.textContent).toContain("مورد بلا حركات");
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
    // a valid row on s-2 (no entries) beside the invalid one keeps totalRows > 0,
    // so the empty-batch check cannot mask the block: the invalid-row guard itself
    // must stop the request, and without it the valid row would be sent
    await submitForm(() => typeIntoRow(0, "abc"));

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("rejects a decimal-grouped amount with a row error instead of saving 100x (Greptile round 2)", async () => {
    render();
    await settle();
    // a valid row on s-2 beside the rejected one, so the empty-batch check cannot
    // mask the block and a dropped guard would send the valid row
    await submitForm(() => typeIntoRow(0, "1 000,00"));

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("rejects a negative amount draft instead of saving its magnitude (issue 207)", async () => {
    // two no-entry suppliers: a parser that accepted or stripped the sign would
    // send the valid row plus the negative one, so `captured === null` alone
    // fails. The `<= 0` branch itself is pinned by the two amount-0 tests.
    suppliers = TWO_NO_ENTRY_SUPPLIERS;
    render();
    await settle();
    await submitForm(() => typeIntoRow(0, "-5"));

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("accepts amount 1 at the low end of the accepted range (issue 207)", async () => {
    render();
    await settle();
    // the enabled control is part of the tripwire, asserted inside the arm: this
    // boundary must NOT be blocked like the reject cases above
    await submitForm(() => {
      expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);
    }, "1");
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-2", amount: 1 });
  });

  it("rejects amount 0, one below the accepted range (issue 207)", async () => {
    // two no-entry suppliers, so a dropped `<= 0` check sends the batch and the
    // `captured === null` assertion fails on its own
    suppliers = TWO_NO_ENTRY_SUPPLIERS;
    render();
    await settle();
    await submitForm(() => typeIntoRow(0, "0"));

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("accepts the largest safe amount, the high end of the accepted range (issue 207)", async () => {
    render();
    await settle();
    // enabled-control tripwire, as for amount 1 above
    await submitForm(() => {
      expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);
    }, String(Number.MAX_SAFE_INTEGER));
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "s-2", amount: Number.MAX_SAFE_INTEGER });
  });

  it("rejects an amount one above the largest safe integer (issue 207)", async () => {
    // two no-entry suppliers, so a dropped safe-integer check sends the batch and
    // the `captured === null` assertion fails on its own
    suppliers = TWO_NO_ENTRY_SUPPLIERS;
    render();
    await settle();
    await submitForm(() => typeIntoRow(0, String(Number.MAX_SAFE_INTEGER + 1)));

    expect(host.querySelector('[data-testid="opening-balance-amount-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("rejects amount 0 in the typed new row (issue 207)", async () => {
    render();
    await settle();
    // the typed row has its own `amount <= 0` branch, separate from the existing
    // rows' reader; the helper's valid row keeps the batch non-empty
    await submitForm(() => {
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد جديد تماما");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "0");
    });

    expect(host.querySelector('[data-testid="opening-balance-typed-error-0"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("blocks an incomplete inline supplier instead of dropping it (Greptile finding 1)", async () => {
    render();
    await settle();
    // a valid row so the empty-batch check cannot mask the incomplete-name block
    await submitForm(() => setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورّد بلا مبلغ"));

    expect(host.querySelector('[data-testid="opening-balance-typed-error-0"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("blocks a batch over the 200-row contract limit before saving (Greptile finding 4)", async () => {
    suppliers = Array.from({ length: 200 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(200);
    // the whole valid batch is the 200 rows plus the typed row, so `null` stops
    // the helper adding its own valid no-entry row
    await submitForm(() => {
      // batched into one render for the same #193 reason as the round-5 case below
      fillAmounts(Array.from(inputs), (index) => String(index + 1));
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد إضافي");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "1");
    }, null);

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);

  it("saves a batch of exactly the 200-row limit at the boundary (issue 207)", async () => {
    suppliers = Array.from({ length: 200 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(200);
    // the whole valid batch is built here, so `null` stops the helper adding a
    // row; exactly the cap is allowed, only a larger batch is blocked
    await submitForm(() => {
      // batched into one render, the same #193 cost guard as the over-limit case
      fillAmounts(Array.from(inputs), () => "1");
      expect(host.querySelector('[data-testid="opening-balance-blocked"]')).toBeNull();
      expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(false);
    }, null);
    expect(captured?.rows).toHaveLength(200);
    // every row keeps its own amount, so the cap is not met by dropping or
    // duplicating a row
    expect(captured?.rows.every((row) => row.amount === 1)).toBe(true);
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);

  it("saves a typed row that brings the batch to exactly the 200-row limit (issue 207)", async () => {
    // 199 filled rows plus the typed row is exactly the cap and must save. That
    // the cap COUNTS the typed row is pinned by the over-limit test above (200
    // filled plus a typed row is 201 and must block).
    suppliers = Array.from({ length: 199 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(199);
    // the whole valid batch is built here, so `null` stops the helper adding a row
    await submitForm(() => {
      fillAmounts(Array.from(inputs), () => "1");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد إضافي");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "1");
    }, null);

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).toBeNull();
    expect(captured?.rows).toHaveLength(200);
    expect(captured?.rows.at(-1)).toMatchObject({ newSupplierName: "مورد إضافي", amount: 1 });
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
    // the save changes supplier accounts, so all three supplier reads refresh —
    // including the account summary the confirmation gate reads
    expect(keys).toContain(JSON.stringify(["suppliersListNames"]));
    expect(keys).toContain(JSON.stringify(["suppliersAccountSummaries"]));
    expect(keys).toContain(JSON.stringify(["suppliersList"]));
  });

  it("sends a typed name as newSupplierName with the named id as a consistency check (round 5 / #184)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!;

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");

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
    const nameField = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!;
    setInput(nameField, "اسم مختلف");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد جديد تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
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

  it("keeps the dialog closed when Escape lands while a refusal's recovery lookup is pending (review round 3 finding 1)", async () => {
    await openConfirmWithRefusedSaveHeld();

    // Escape dismisses while the recovery lookup is still pending
    await act(async () => {
      clickTarget("opening-balance-confirm").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();

    // the held lookup settles: the explicit dismissal must survive the refusal
    // recovery, so the dialog stays CLOSED (it is not re-opened with the moved name)
    await releaseHeldRecovery();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    // positive control: the recovery lookup really ran, so "stays closed" is not
    // passing vacuously (1 initial submit resolve + 1 recovery resolve)
    expect(resolveCalls).toBe(2);
  });

  // one case per new-tab activation: the confirmation must survive every one of
  // them, because none of them leaves THIS tab (Greptile round 4)
  for (const [label, activation] of NEW_TAB_ACTIVATIONS) {
    it(`keeps the dialog open when a ${label} hits the back link while a refusal's recovery lookup is pending (review round 4)`, async () => {
      await openConfirmWithRefusedSaveHeld();
      dispatchClickOn("opening-balance-back", activation);

      // the held lookup settles: because the owner never left this tab, the
      // recovery must still re-open the dialog, now naming the moved account
      await releaseHeldRecovery();
      expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
      const names = Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
      expect(names).toContain("مورد بديل");
      // positive control: the recovery lookup really ran, so "still there" is not
      // passing vacuously (1 initial submit resolve + 1 recovery resolve)
      expect(resolveCalls).toBe(2);
    });
  }

  it("abandons the dialog on a plain back-link click while a refusal's recovery lookup is pending (review round 4 control)", async () => {
    // the control for the new-tab cases: a plain click DOES navigate this tab, so
    // it must abandon — otherwise they could all pass by never abandoning.
    await openConfirmWithRefusedSaveHeld();
    dispatchClickOn("opening-balance-back", { button: 0 });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();

    // the held lookup settles: the dismissal must survive the refusal recovery
    await releaseHeldRecovery();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    // positive control: the recovery lookup still ran; only its re-open was dropped
    expect(resolveCalls).toBe(2);
  });

  it("keeps the dialog open when the back link targets a new tab while a refusal's recovery lookup is pending (review round 4 debate)", async () => {
    // a plain click on a `target="_blank"` link opens a new tab: the predicate must
    // not treat it as a current-tab navigation just because the click is unmodified
    // (debate critic: the guard must not be a weaker copy of the router's own).
    await openConfirmWithRefusedSaveHeld();
    clickTarget("opening-balance-back").setAttribute("target", "_blank");
    dispatchClickOn("opening-balance-back", { button: 0 });

    await releaseHeldRecovery();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    // positive control: the recovery lookup really ran (1 submit + 1 recovery)
    expect(resolveCalls).toBe(2);
  });

  it("dismisses on Escape from an input behind the open dialog (review round 3 class fix)", async () => {
    // the inline dialog has no focus trap: Escape must be handled at the form so
    // an owner who tabbed back into an amount field can still dismiss it
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // Focus is outside the dialog subtree, in an input behind it
    const amount = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!;
    amount.focus();
    await act(async () => {
      amount.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
  });

  it("does not suppress a legitimate dialog after an earlier dismissal (review round 3)", async () => {
    // a dismissal must not become a permanent latch: a later submit for the moved
    // destination still re-opens the dialog and names it
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    // refuse the confirmed save and dismiss the dialog while recovery is held
    rejectTargetChanged = true;
    racedAfterRefusal = { key: normalizeTextKey("مورد له حركات"), supplier: { id: "s-moved", name: "مورد بديل", accountEntryCount: 4 } };
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    act(() => {
      clickOn("opening-balance-confirm-save");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="opening-balance-confirm"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    await act(async () => {
      releaseResolveHold?.();
      resolveHold = null;
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();

    // a NEW submit for the same (now moved) name must open the dialog again
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    const names = Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
    expect(names).toContain("مورد بديل");
  });

  it("disables the confirm button while a re-submit's lookup is pending (review round 2)", async () => {
    render();
    await settle();
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد إغلاق تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد جديد تماما");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");
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
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!;
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد ميدان تماما");
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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");
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
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!;
    setInput(nameInput, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, typed);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    // an explicit row for s-2 (no entries, so no confirmation can mask the guard)
    // plus a typed name that folds to the same name
    await submitForm(() => {
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد  بلا حركات");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");
    }, "700");

    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("never loads the full party list — the conflict check rides the names-only seam (#183)", async () => {
    render();
    await settle();
    expect(suppliersListUsed).toBe(false);
    // the table rendered from the two lean reads
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')).toHaveLength(BASE_SUPPLIERS.length);
  });

  it("blocks the save when the account summary fails instead of skipping the confirmation gate (#183)", async () => {
    render();
    await settle();
    // a valid typed-name row on s-2 (no cached entries). Filling it first keeps
    // totalRows > 0, so the empty-batch check cannot be what blocks the request:
    // only the failed-read guard can, and without it this row would be sent.
    // `null` skips the helper's own row: the typed row is this test's valid batch.
    await submitForm(async () => {
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد بلا حركات");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "400");

      // the summary read now fails on refetch: its counts are no longer trustworthy
      accountsShouldFail = true;
      await act(async () => {
        await queryClient!.invalidateQueries({ queryKey: ["suppliersAccountSummaries"] });
      });
      await settle();
    }, null);

    expect(host.querySelector('[data-testid="opening-balance-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("blocks the save when the names read fails instead of skipping the conflict check (#183)", async () => {
    render();
    await settle();
    // a valid typed-name row on s-2 (no cached entries), so totalRows > 0 and the
    // empty-batch check cannot be what blocks the request; without the guard the
    // row would be sent with the conflict list unknown. `null` skips the helper's
    // own row: the typed row is this test's valid batch.
    await submitForm(async () => {
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد بلا حركات");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "400");

      // the names read now fails on refetch: the conflict list is no longer trusted
      namesShouldFail = true;
      await act(async () => {
        await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
      });
      await settle();
    }, null);

    expect(host.querySelector('[data-testid="opening-balance-error"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    expect(captured).toBeNull();
  });

  it("blocks the confirm-save when the account summary fails after the dialog opens (#183)", async () => {
    render();
    await settle();
    // s-1 carries entries, so filling its row opens the confirmation dialog
    typeIntoRow(0, "100");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();

    // a later refetch of the account summary fails while the dialog is open
    accountsShouldFail = true;
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersAccountSummaries"] });
    });
    await settle();

    // Known exception (#207): do NOT "fix" this by weakening the assertion.
    // `captured === null` here is masked by the disabled control, not by a guard
    // this test reaches: the same `listFailed` flag both disables this button and
    // backs `save()`, and React suppresses `onClick` on a control whose memoized
    // `props.disabled` is true, so `save(true)` is unreachable through the UI.
    // The disabled assertion is the real evidence the owner cannot fire the
    // write; making the save(`true`) branch reachable needs a PRODUCTION change
    // and belongs in its own issue. Removing it would make this test vacuous.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-confirm-save"]')?.disabled).toBe(true);
    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured).toBeNull();
  });

  /** Greptile round 3 — the two supplier reads that gate the save. A waiting
   * submission must consult the read failure that exists when it writes, not the
   * one the render that started it saw. */
  const WAITING_READ_FAILURES: Array<{ label: string; queryKey: string[]; fail: () => void; recover: () => void }> = [
    { label: "names read", queryKey: ["suppliersListNames"], fail: () => { namesShouldFail = true; }, recover: () => { namesShouldFail = false; } },
    { label: "account summary read", queryKey: ["suppliersAccountSummaries"], fail: () => { accountsShouldFail = true; }, recover: () => { accountsShouldFail = false; } },
  ];
  for (const { label, queryKey, fail, recover } of WAITING_READ_FAILURES) {
    it(`does not write when the ${label} fails while the name lookup is held (#183, Greptile round 3)`, async () => {
      // park submit() inside its resolve await, then fail the read WHILE it
      // waits. Failing the read before submit() starts would pass even against
      // the defect: the render that started submit() would already carry
      // `listFailed === true`.
      resolveHold = new Promise((resolve) => {
        releaseResolveHold = resolve;
      });
      render();
      await settle();
      // a new supplier (the resolver answers null) with no entries: this row
      // takes the direct-save path the finding names
      setInput(clickTarget<HTMLInputElement>("opening-balance-typed-name-0"), "مورد جديد تماما");
      setInput(clickTarget<HTMLInputElement>("opening-balance-typed-amount-0"), "500");
      await act(async () => {
        clickOn("opening-balance-save");
      });
      expect(resolveCalls).toBe(1);

      fail();
      await act(async () => {
        await queryClient!.invalidateQueries({ queryKey });
      });
      await settle();
      // the read really failed while the lookup was still held
      expect(clickTarget("opening-balance-error")).not.toBeNull();

      // release the held lookup: the waiting continuation must not write
      await act(async () => {
        releaseResolveHold?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      await settle();
      expect(captured).toBeNull();
      expect(mutationCalls).toBe(0);
      expect(host.querySelector('[data-testid="opening-balance-saved"]')).toBeNull();

      // recovery: clearing the failure must unblock the owner, and a fresh
      // write proves the released continuation really resumed (a dropped one
      // would also show no write above)
      recover();
      await act(async () => {
        await queryClient!.invalidateQueries({ queryKey });
      });
      await settle();
      await act(async () => {
        clickOn("opening-balance-save");
      });
      await settle();
      expect(mutationCalls).toBe(1);
      expect(captured).not.toBeNull();
    });
  }

  it("does not open the confirmation off a read that failed while the name lookup was held (#183, Greptile round 3)", async () => {
    // the typed name resolves to an account that already carries an entry, so a
    // healthy read would open the dialog; a read failing during the held lookup
    // must not let the continuation name counts the failed read no longer backs
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    // beforeEach resolves "مورد له حركات" to s-1 (accountEntryCount 3)
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-name-0"), "مورد له حركات");
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-amount-0"), "500");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(resolveCalls).toBe(1);

    accountsShouldFail = true;
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersAccountSummaries"] });
    });
    await settle();
    expect(clickTarget("opening-balance-error")).not.toBeNull();

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

  it("resolves a folded typed name to the server's existing account and confirms it (#183/#184)", async () => {
    // the server is the only resolver (issue 184): the fold maps to s-3, whose
    // account already carries an entry, so the dialog asks before writing
    resolveByKey.set(normalizeTextKey("مورد  رصيد سالب"), { id: "s-3", name: "مورد رصيد سالب", accountEntryCount: 1 });
    render();
    await settle();
    // "مورد  رصيد سالب" (double space) folds to s-3's "مورد رصيد سالب"
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد  رصيد سالب");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "250");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    // the dialog names the server's stored text, not the typed string
    expect(host.querySelector('[data-testid="opening-balance-confirm-name"]')?.textContent).toBe("مورد رصيد سالب");

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ newSupplierName: "مورد  رصيد سالب", amount: 250, confirmExisting: true, expectedSupplierId: "s-3" });
  });

  it("does not cut off an owner still typing a new name that starts like an existing one (round 5)", async () => {
    render();
    await settle();
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!;
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!;

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
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!;
    await act(async () => {
      nameInput.focus();
    });
    setInput(nameInput, "مورد له حركات");
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "500");

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
    const rowAmount = () => host.querySelectorAll('[data-testid="opening-balance-row"]')[1]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value;

    // s-2 has no entries, so no confirmation dialog can mask the conflict guard
    await submitForm(() => {
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد  بلا حركات");
      setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "300");
    }, "700");

    // the row keeps the owner's earlier 700; the inline draft is left for the
    // conflict guard to flag rather than clobbering or double-posting
    expect(rowAmount()).toBe("700");
    expect(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')?.value).toBe("300");

    // nothing is sent: one opening balance per supplier, never two entries. The
    // conflict is visible and blocks the save before any request.
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
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
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, typedName);
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!, "400");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    const confirmNames = () => Array.from(host.querySelectorAll('[data-testid="opening-balance-confirm-name"]')).map((el) => el.textContent ?? "");
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
    expect(confirmNames()).toContain(typedName);

    // the raced supplier exists on the server, but the client has not seen it yet:
    // the mocked refusal injects it into the next resolve, and the page's OWN
    // refusal handler refreshes the lean reads without the test invalidating them.

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
    expect(keys).toContain(JSON.stringify(["suppliersListNames"]));
    // the entries the confirmation gate reads live in the account summary: a
    // refusal that refreshed only the names would leave the owner retrying with
    // stale counts and looping on the same refusal
    expect(keys).toContain(JSON.stringify(["suppliersAccountSummaries"]));
    // the write changes supplier accounts, so the full list other screens read is still refreshed
    expect(keys).toContain(JSON.stringify(["suppliersList"]));
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).not.toBeNull();
  });

  it("tells the owner and blocks the save when a refresh removes a filled row's supplier (#204)", async () => {
    suppliers = [
      { id: "keep", name: "مورد باقي", accountBalance: 0, accountEntryCount: 0 },
      { id: "gone", name: "مورد زائل", accountBalance: 0, accountEntryCount: 0 },
    ];
    render();
    await settle();

    // both rows are filled before the refresh drops one supplier
    typeIntoRow(0, "100");
    typeIntoRow(1, "300");

    // a background refresh removes `gone`
    suppliers = suppliers.filter((supplier) => supplier.id !== "gone");
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();

    // the owner is named the supplier and the amount, in i18n copy — never silent
    const notice = clickTarget("opening-balance-removed");
    expect(notice.textContent).toContain(i18n.t("supplierOpeningRemovedTitle"));
    const removedRow = clickTarget("opening-balance-removed-row");
    expect(removedRow.textContent).toContain(i18n.t("supplierOpeningRemovedRow", { name: "مورد زائل" }));
    expect(removedRow.textContent).toContain("300");

    // the save is blocked: the button is disabled and the form guard refuses too
    expect(host.querySelector<HTMLButtonElement>('[data-testid="opening-balance-save"]')?.disabled).toBe(true);
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    // the programmatic path still names the reason, so a bypassed disabled button
    // is not a silent no-op
    expect(host.querySelector('[data-testid="opening-balance-form-error"]')?.textContent).toContain(i18n.t("supplierOpeningRemovedBlocked"));

    // acknowledging the loss re-enables the save, and the surviving row still goes
    clickOn("opening-balance-removed-dismiss");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "keep", amount: 100 });
  });

  it("drops an untouched row silently when its supplier vanishes on a refresh (#204 negative)", async () => {
    suppliers = [
      { id: "keep", name: "مورد باقي", accountBalance: 0, accountEntryCount: 0 },
      { id: "gone", name: "مورد زائل", accountBalance: 0, accountEntryCount: 0 },
    ];
    render();
    await settle();

    // only the surviving row is filled; the removed one stays empty
    typeIntoRow(0, "100");

    suppliers = suppliers.filter((supplier) => supplier.id !== "gone");
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();

    // no warning for the ordinary case: an unfilled row may drop without noise
    expect(host.querySelector('[data-testid="opening-balance-removed"]')).toBeNull();
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "keep", amount: 100 });
  });

  it("names every filled row a single refresh removes, then saves only the survivors (#204)", async () => {
    suppliers = [
      { id: "a", name: "مورد أ", accountBalance: 0, accountEntryCount: 0 },
      { id: "b", name: "مورد ب", accountBalance: 0, accountEntryCount: 0 },
      { id: "c", name: "مورد ج", accountBalance: 0, accountEntryCount: 0 },
    ];
    render();
    await settle();
    typeIntoRow(0, "100");
    typeIntoRow(1, "200");
    typeIntoRow(2, "300");

    // one refresh removes two filled rows
    suppliers = suppliers.filter((supplier) => supplier.id === "c");
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();

    // both losses are named, not just the first
    expect(host.querySelectorAll('[data-testid="opening-balance-removed-row"]')).toHaveLength(2);

    clickOn("opening-balance-removed-dismiss");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows).toHaveLength(1);
    expect(captured?.rows[0]).toMatchObject({ supplierId: "c", amount: 300 });
  });

  it("never writes a supplier removed during the submit's async name lookup (#204 review)", async () => {
    suppliers = [
      { id: "keep", name: "مورد باقي", accountBalance: 0, accountEntryCount: 0 },
      { id: "gone", name: "مورد زائل", accountBalance: 0, accountEntryCount: 0 },
    ];
    // park submit() inside its resolver await, the window a captured render value
    // would miss
    resolveHold = new Promise((resolve) => {
      releaseResolveHold = resolve;
    });
    render();
    await settle();
    typeIntoRow(0, "100");
    typeIntoRow(1, "300");
    // a typed name forces the resolver to be awaited before save() runs
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-name-0"), "مورد جديد تماما");
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-amount-0"), "50");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(resolveCalls).toBe(1);

    // the names refetch finishes and publishes the fresh list while the lookup is
    // still unanswered. `setQueryData` is that refetch's synchronous cache write;
    // React Query schedules the re-render (and so the removal effect) on a
    // macrotask, so the resumed save() observes the fresh cache BEFORE the effect
    // commits. Releasing the held lookup in the same tick pins that ordering; the
    // old test's `settle()`-then-release let the effect win first, which is the
    // window that hid the bug.
    suppliers = suppliers.filter((supplier) => supplier.id !== "gone");
    const freshNames = suppliers.map(({ id, name }) => ({ id, name }));
    await act(async () => {
      queryClient!.setQueryData(["suppliersListNames"], { items: freshNames });
      releaseResolveHold?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    // the loss is still surfaced, never silently swallowed
    expect(clickTarget("opening-balance-removed")).not.toBeNull();
  });

  it("closes the confirmation when a refresh removes a row it named (#204 review)", async () => {
    render();
    await settle();
    // s-1 carries entries: filling it opens the confirmation
    typeIntoRow(0, "800");
    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(clickTarget("opening-balance-confirm")).not.toBeNull();

    suppliers = BASE_SUPPLIERS.filter((supplier) => supplier.id !== "s-1");
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();

    // the dialog named a batch that changed: it must close, and the loss surfaced
    expect(host.querySelector('[data-testid="opening-balance-confirm"]')).toBeNull();
    expect(clickTarget("opening-balance-removed").textContent).toContain("مورد له حركات");
  });

  it("keeps the drafts when a refetch of the supplier read fails, never flagging a phantom removal (#204 review)", async () => {
    suppliers = [
      { id: "keep", name: "مورد باقي", accountBalance: 0, accountEntryCount: 0 },
      { id: "other", name: "مورد ثان", accountBalance: 0, accountEntryCount: 0 },
    ];
    render();
    await settle();
    typeIntoRow(0, "100");

    namesShouldFail = true;
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();

    // a failed refetch keeps the previous data: no phantom removal notice
    expect(host.querySelector('[data-testid="opening-balance-removed"]')).toBeNull();
    // the failed read still blocks on its own existing reason
    expect(host.querySelector('[data-testid="opening-balance-error"]')).not.toBeNull();
  });

  it("keeps filled drafts when the supplier query is reset and its replacement read is held (#204 review)", async () => {
    suppliers = [
      { id: "keep", name: "مورد باقي", accountBalance: 0, accountEntryCount: 0 },
      { id: "other", name: "مورد ثان", accountBalance: 0, accountEntryCount: 0 },
    ];
    render();
    await settle();
    typeIntoRow(0, "100");
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-name-0"), "مورد جديد تماما");
    setInput(clickTarget<HTMLInputElement>("opening-balance-typed-amount-0"), "50");

    // reset the names query while its replacement read is held, then let the
    // reset render while `data` is undefined: an undefined list must NOT read as
    // "every supplier vanished"
    namesHold = new Promise((resolve) => {
      releaseNamesHold = resolve;
    });
    await act(async () => {
      void queryClient!.resetQueries({ queryKey: ["suppliersListNames"] });
    });
    await settle();
    // no phantom removal while the read carries no data, and the page is on the
    // loading state — this is the window the previous test never reached
    expect(host.querySelector('[data-testid="opening-balance-removed"]')).toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-loading"]')).not.toBeNull();

    // release the replacement read: the typed draft survived the null window and
    // the batch still carries the owner's amount
    await act(async () => {
      releaseNamesHold?.();
      namesHold = null;
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="opening-balance-removed"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="opening-balance-row"]')[0]?.querySelector<HTMLInputElement>('[data-testid="opening-balance-amount"]')?.value).toBe("100");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows).toHaveLength(2);
    expect(captured?.rows.find((row) => row.supplierId === "keep")).toMatchObject({ amount: 100 });
    expect(captured?.rows.find((row) => row.newSupplierName === "مورد جديد تماما")).toMatchObject({ amount: 50 });
  });

  it("counts a typed name toward the batch limit and blocks before the server (round 5)", async () => {
    suppliers = Array.from({ length: 201 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
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
    const amountInput = host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-amount-0"]')!;
    setInput(host.querySelector<HTMLInputElement>('[data-testid="opening-balance-typed-name-0"]')!, "مورد 200");
    setInput(amountInput, "5");
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });

    // 200 filled + the resolved row is over the cap: the page blocks, never sends
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')?.textContent).toContain("200");
    expect(captured).toBeNull();
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);
});

/**
 * #255 — the owner migrates a paper book, so dozens of opening balances are typed
 * in one sitting. The page already accepted a 200-row batch; only the typed
 * (new-supplier) draft was one row at a time, so five new parties cost five saves.
 * Row 0 is the row the page opens with, rows 1.. are added with the add control.
 */
describe("bulk add-a-row on the opening-balance draft (issue 255)", () => {
  function typedNameInput(index: number): HTMLInputElement {
    const el = host.querySelector<HTMLInputElement>(`[data-testid="opening-balance-typed-name-${index}"]`);
    if (el === null) throw new Error(`missing typed name input for draft row ${index}`);
    return el;
  }

  function typedAmountInput(index: number): HTMLInputElement {
    const el = host.querySelector<HTMLInputElement>(`[data-testid="opening-balance-typed-amount-${index}"]`);
    if (el === null) throw new Error(`missing typed amount input for draft row ${index}`);
    return el;
  }

  function fillTypedRow(index: number, name: string, amount: string) {
    setInput(typedNameInput(index), name);
    setInput(typedAmountInput(index), amount);
  }

  function saveButton(): HTMLButtonElement {
    return clickTarget<HTMLButtonElement>("opening-balance-save");
  }

  /** The testid of the focused control (its tag name when it carries none), so a
   * failed focus assertion prints two short strings instead of two React DOM
   * trees. */
  function activeControlTestId(): string {
    const active = document.activeElement;
    return active?.getAttribute("data-testid") ?? active?.tagName ?? "none";
  }

  /** Every typed draft row in the table, in order. A prefix count, because a
   * per-row testid of its own (`typed-row-0`) is true whether or not its siblings
   * rendered. */
  function typedRowCount(): number {
    return host.querySelectorAll('[data-testid^="opening-balance-typed-row-"]').length;
  }

  /** Open a typed row's direction Select and commit the option with this label.
   * Base UI arms selection on `pointerdown` and commits on `click` — the same
   * sequence invoice-returns.test.tsx drives its settlement Select with. */
  async function pickTypedDirection(index: number, label: string) {
    const trigger = clickTarget(`opening-balance-typed-direction-${index}`);
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const optionText = (element: HTMLElement) => (element.textContent ?? "").trim();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => optionText(element) === label);
    if (option === undefined) throw new Error(`no "${label}" option in the row ${index} direction Select`);
    act(() => {
      option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
    });
  }

  it("adds five rows and saves them in ONE request", async () => {
    render();
    await settle();

    const names = ["مورد أ", "مورد ب", "مورد ج", "مورد د", "مورد ه"];
    for (let index = 1; index < names.length; index += 1) clickOn("opening-balance-add-row");
    names.forEach((name, index) => fillTypedRow(index, name, String((index + 1) * 100)));

    expect(typedRowCount()).toBe(5);
    await act(async () => {
      clickOn("opening-balance-save");
    });

    // the acceptance criterion: five parties, five settlements, one write
    expect(mutationCalls).toBe(1);
    expect(captured?.rows).toHaveLength(5);
    expect(captured?.rows.map((row) => row.newSupplierName)).toEqual(names);
    expect(captured?.rows.map((row) => row.amount)).toEqual([100, 200, 300, 400, 500]);
    // every one of them is a NAMED row: the server resolves each, none is retargeted
    expect(captured?.rows.every((row) => row.supplierId === undefined && row.expectedSupplierId === null)).toBe(true);
  });

  it("keeps each typed row's own text when another row is added", async () => {
    render();
    await settle();

    fillTypedRow(0, "مورد أول", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد ثان", "400");

    // the first row is a different draft: adding a row must not move or clear it
    expect(typedNameInput(0).value).toBe("مورد أول");
    expect(typedAmountInput(0).value).toBe("300");
    expect(typedNameInput(1).value).toBe("مورد ثان");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows.map((row) => row.newSupplierName)).toEqual(["مورد أول", "مورد ثان"]);
  });

  it("removes exactly the row its control belongs to", async () => {
    render();
    await settle();

    fillTypedRow(0, "مورد يبقى", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد يُزال", "400");
    clickOn("opening-balance-add-row");
    fillTypedRow(2, "مورد أخير", "500");

    clickOn("opening-balance-typed-remove-1");
    // the survivors keep their order, their text AND their amounts: a re-index
    // bug shows up as a name that kept its row while the amount moved
    expect(typedRowCount()).toBe(2);
    expect(typedNameInput(0).value).toBe("مورد يبقى");
    expect(typedAmountInput(0).value).toBe("300");
    expect(typedNameInput(1).value).toBe("مورد أخير");
    expect(typedAmountInput(1).value).toBe("500");
    expect(host.querySelector('[data-testid="opening-balance-typed-name-2"]')).toBeNull();

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(mutationCalls).toBe(1);
    expect(captured?.rows.map((row) => row.newSupplierName)).toEqual(["مورد يبقى", "مورد أخير"]);
    expect(captured?.rows.map((row) => row.amount)).toEqual([300, 500]);
  });

  it("moves focus to the row that took the removed row's place", async () => {
    render();
    await settle();

    fillTypedRow(0, "مورد أول", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد ثان", "400");

    // the remove control unmounts with its row: focus must not fall to the body
    act(() => clickTarget("opening-balance-typed-remove-0").focus());
    clickOn("opening-balance-typed-remove-0");
    expect(document.activeElement).toBe(typedNameInput(0));

    // the last remaining row goes too: focus lands on the control that brings one back
    clickOn("opening-balance-typed-remove-0");
    expect(document.activeElement).toBe(clickTarget("opening-balance-add-row"));
  });

  it("moves focus to an enabled control when the add control is at the row cap", async () => {
    suppliers = Array.from({ length: 200 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    // 200 filled rows put the batch exactly at the contract's row cap, so the add
    // control is disabled — and a disabled element cannot receive focus
    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    expect(inputs).toHaveLength(200);
    fillAmounts(Array.from(inputs), () => "1");
    expect(clickTarget<HTMLButtonElement>("opening-balance-add-row").disabled).toBe(true);

    // the owner removes the last typed draft: its remove control unmounts with its
    // row, and the control the page used to fall back to is the disabled add. Focus
    // must land on a control that can still take it, not on document.body
    // (Greptile round 5).
    act(() => clickTarget("opening-balance-typed-remove-0").focus());
    clickOn("opening-balance-typed-remove-0");
    // focus must be on a control that can still take it, not on document.body
    expect(activeControlTestId()).toBe("opening-balance-save");
    // positive control for the assertion above: the fallback target is focusable
    // by construction, so a passing `toBe` cannot come from a disabled element
    expect(saveButton().disabled).toBe(false);
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);
  it("blocks a typed row whose name folds to no identity (Greptile round 3 finding 2)", async () => {
    render();
    await settle();

    // RLM is not whitespace, so the raw-trim gate let this row through as FILLED.
    // The server then folds the whole batch to one empty key and refuses it
    // (DUPLICATE_OPENING_BALANCE_ROW), losing every amount. Block it first.
    fillTypedRow(0, "\u200f", "800");

    const rowError = host.querySelector('[data-testid="opening-balance-typed-error-0"]');
    expect(rowError?.textContent ?? "").toContain("أكمل");
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);

    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
  });

  it("resolves the whole typed batch in ONE lookup, not one per row (Greptile round 3 finding 3)", async () => {
    render();
    await settle();

    const names = ["مورد خدمة أ", "مورد خدمة ب", "مورد خدمة ج", "مورد خدمة د"];
    names.forEach((name, index) => {
      if (index > 0) clickOn("opening-balance-add-row");
      fillTypedRow(index, name, String((index + 1) * 10));
    });

    await act(async () => {
      clickOn("opening-balance-save");
    });

    // the four names are new; the point is the LOOKUP count: one batch read for
    // the whole draft, where a per-row resolve would have asked four times and
    // each ask would have reread every name and every account summary
    expect(resolveCalls).toBe(1);
    expect(mutationCalls).toBe(1);
    expect(captured?.rows).toHaveLength(4);
    expect(captured?.rows.map((row) => row.newSupplierName)).toEqual(names);
  });

  it("keeps each row's own destination and confirmation answer in a mixed batch (Greptile round 3 finding 4)", async () => {
    render();
    await settle();

    // row 0 folds onto s-1, which carries entries; row 1 is new. A per-row
    // destination map that crossed the two answers would still save both names.
    fillTypedRow(0, "مورد له حركات", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورّد جديد تماما", "400");

    await act(async () => {
      clickOn("opening-balance-save");
    });

    // the confirmation comes first: nothing is written until it is confirmed
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
    expect(clickTarget("opening-balance-confirm")).not.toBeNull();

    await act(async () => {
      clickOn("opening-balance-confirm-save");
    });

    expect(mutationCalls).toBe(1);
    expect(captured?.rows).toHaveLength(2);
    const existing = captured?.rows.find((row) => row.newSupplierName === "مورد له حركات");
    const fresh = captured?.rows.find((row) => row.newSupplierName === "مورّد جديد تماما");
    expect(existing).toMatchObject({ direction: "WE_OWE", amount: 300, confirmExisting: true, expectedSupplierId: "s-1" });
    expect(fresh).toMatchObject({ direction: "WE_OWE", amount: 400, expectedSupplierId: null });
    // the fresh row was not confirmed: the dialog named only the existing account
    expect(fresh?.confirmExisting).toBeUndefined();
  });

  it("keeps each row's direction and sends it with that row", async () => {
    render();
    await settle();

    fillTypedRow(0, "مورد مدين", "100");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد دائن", "200");
    // the second row is the credit one; the first must keep its default.
    // #260 — a credit is THEY_OWE, whose label is now نسالوه
    await pickTypedDirection(1, "نسالوه");

    await act(async () => {
      clickOn("opening-balance-save");
    });
    expect(captured?.rows.map((row) => row.direction)).toEqual(["WE_OWE", "THEY_OWE"]);
  });

  it("blocks the save when two rows name the same supplier", async () => {
    render();
    await settle();

    // folded by normalizeTextKey: the server refuses such a batch outright
    // (DUPLICATE_OPENING_BALANCE_ROW), which would lose every amount in it
    fillTypedRow(0, "مورد  مكرر", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد مكرر", "400");

    // BOTH rows are named, not just the later one: either side is the row the
    // owner can edit, and flagging one leaves the other looking valid
    expect(host.querySelector('[data-testid="opening-balance-typed-error-0"]')?.textContent).toContain("صفّ آخر");
    expect(host.querySelector('[data-testid="opening-balance-typed-error-1"]')?.textContent).toContain("صفّ آخر");
    expect(host.querySelector('[data-testid="opening-balance-blocked"]')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);

    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="opening-balance-form"]')!.requestSubmit();
    });
    expect(captured).toBeNull();
    expect(mutationCalls).toBe(0);
  });

  it("blocks two rows that fold onto one supplier the batch already carries", async () => {
    render();
    await settle();

    // the owner fills s-1's own row, then types two spellings of the same supplier:
    // both fold to the filled row, so the same account would be posted three times
    typeIntoRow(0, "100");
    fillTypedRow(0, "مورد له حركات", "300");
    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد  له حركات", "400");

    expect(host.querySelector('[data-testid="opening-balance-typed-error-0"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="opening-balance-typed-error-1"]')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    await act(async () => {
      clickTarget<HTMLButtonElement>("opening-balance-save").click();
    });
    expect(captured).toBeNull();
  });

  it("counts every added row on the save button, in the Arabic plural form", async () => {
    render();
    await settle();

    // the plural categories themselves are pinned in lib/i18n.test.ts; this is the
    // wiring: the count the page sends is the number of rows it will write
    const label = () => saveButton().textContent ?? "";
    fillTypedRow(0, "مورد أ", "100");
    expect(label()).toBe("حفظ تسوية واحدة");

    clickOn("opening-balance-add-row");
    fillTypedRow(1, "مورد ب", "200");
    expect(label()).toBe("حفظ تسويتين");

    clickOn("opening-balance-add-row");
    fillTypedRow(2, "مورد ج", "300");
    expect(label()).toBe("حفظ 3 تسويات");
  });

  it("stops adding rows at the 200-row contract cap", async () => {
    suppliers = Array.from({ length: 200 }, (_value, index) => ({
      id: `bulk-${index}`,
      name: `مورد ${index}`,
      accountBalance: 0,
      accountEntryCount: 0,
    }));
    render();
    await settle();

    const inputs = host.querySelectorAll<HTMLInputElement>('[data-testid="opening-balance-amount"]');
    fillAmounts(Array.from(inputs), () => "1");
    // the batch is already at the cap, so a further row could only make it too
    // large: the control is disabled instead of adding a row that cannot save
    expect(clickTarget<HTMLButtonElement>("opening-balance-add-row").disabled).toBe(true);
    expect(host.querySelector('[data-testid="opening-balance-typed-name-1"]')).toBeNull();
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);

  it("stops the draft list at the cap even when every row is blank", async () => {
    render();
    await settle();

    // a blank row is never sent, so the batch cap alone would let the owner press
    // add forever; the DRAFT list carries the same cap
    for (let click = 0; click < 205; click += 1) clickOn("opening-balance-add-row");
    expect(typedRowCount()).toBe(200);
    expect(clickTarget<HTMLButtonElement>("opening-balance-add-row").disabled).toBe(true);
  }, BATCH_LIMIT_TEST_TIMEOUT_MS);
});
