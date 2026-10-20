import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { runE2eReset } from "./reset-helpers";
import { callRpc } from "./rpc-helpers";

/**
 * #295 — the v1 multi-client measurement (#294): two windows, one api.
 *
 * Window A sells. Window B is a second tab in the same browser session, left
 * in the background for the whole test: it is never clicked, never focused,
 * never reloaded. The numbers it shows must still move.
 *
 * WHAT THIS MEASURES, and what it does not. TanStack Query refetches a stale
 * query when its window regains focus, so a window the owner clicks into
 * catches up on its own — that path needs nothing from this ticket. The case
 * it cannot cover is a window that stays visible but unfocused: no focus
 * event fires, so the number on screen stays exactly as old as the last read
 * made it. This test keeps window B in the background and asserts the
 * convergence anyway.
 *
 * WHAT THIS DOES NOT SHOW. The headless runner never hides a tab, so the
 * reader fakes its own hidden document (see below). What the spec shows is
 * the unfocused, hidden window: the reader was never the focused tab and
 * never flipped to visible, and the tick carried the change anyway.
 *
 * HOW THE TICK IS PROVEN, not the focus event. TanStack v5's focus manager
 * listens to `visibilitychange`, not `focus`: it refetches when the document
 * becomes visible. So the counter that matters is the number of
 * visibility-changes that found the reader VISIBLE — zero means the focus
 * path never fired, and with no reload, no interaction and no mutation in
 * the reader window, the bounded tick is the only refetch trigger left. That
 * counter reads the BROWSER's own state, not the hidden one the reader
 * pretends to have, so it can count; a counter reading the pretended state
 * could never fail. The elapsed time is reported as a measurement, not
 * asserted as a bound: the tick's phase relative to the sale is arbitrary,
 * so a fast convergence would not mean a focus refetch happened.
 *
 * The numbers that must move are the two hot counters: today's sales (the
 * count on the dashboard card) and the stock on hand (the item's row in the
 * low-stock list, which only shows once the sale pushes it under its
 * threshold).
 */

// The item and the sale this spec seeds join the shared e2e database, so it
// owes the suite a reset AFTER itself — the contract in `reset-helpers.ts`.
// Without it the next spec inherits a catalog row, a day's sale total and an
// activity entry, and any spec that reads an exact global count breaks on
// the order rather than on its own change.
test.afterAll(() => {
  runE2eReset("reset-e2e-records.mjs");
});

/** The seed payload for one item created with opening stock. */
type SeedItem = {
  name: string;
  categoryId: string;
  costPrice: number;
  sellingPrice: number;
  lowStockThreshold: number;
  barcode: string;
  stockOnHand: number;
};

/** The sales count on the dashboard card, read through its own testid. */
async function readSalesCount(page: Page): Promise<number> {
  const text = (await page.getByTestId("dashboard-sales-count").textContent()) ?? "";
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`no sales count on the card: ${text}`);
  return value;
}

test("a sale in one window moves the hot counters in the other, with no reload", async ({ page, context }, testInfo) => {
  // the convergence waits for a tick, so the default 30s budget is too tight
  test.setTimeout(90_000);

  await signIn(page);

  const stamp = Date.now().toString();
  const itemName = `نضارة-${stamp}`;
  const barcode = `FRESH${stamp}`;

  // the item: 6 in stock against a threshold of 5, so one sale leaves 5 and
  // the item enters the dashboard's low-stock list
  const categories = await callRpc<{ items: Array<{ id: string }> }, Record<string, never>>(page, "categoriesList", {});
  await callRpc<{ id: string }, SeedItem>(page, "itemsCreateWithStock", {
    name: itemName,
    categoryId: categories.items[0]!.id,
    costPrice: 100,
    sellingPrice: 200,
    lowStockThreshold: 5,
    barcode,
    stockOnHand: 6,
  });

  // window B: a second tab in the same session, and counters for the events
  // it must not receive
  const reader = await context.newPage();
  await reader.goto("/");
  await expect(reader.getByTestId("dashboard-page")).toBeVisible();
  await reader.evaluate(() => {
    // The reader's OWN visibility state, read from the prototype rather than
    // from the document. The patch below shadows `document.visibilityState`
    // on this instance, so a counter that reads the document would always
    // read "hidden" and could never count anything — the counter has to see
    // what the BROWSER says, which is the only thing that can contradict it.
    const nativeVisibility = (): string => {
      const getter = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get;
      return getter?.call(document) ?? "unknown";
    };
    // SAFETY: the page installs these counters on its own window and reads
    // them back later in the same test; the cast names the properties it added
    const counter = window as Window & {
      __focusEvents: number;
      __visibilityEvents: number;
      __visibleFlips: number;
      __nativeStates: string[];
    };
    counter.__focusEvents = 0;
    counter.__visibilityEvents = 0;
    counter.__visibleFlips = 0;
    counter.__nativeStates = [];
    window.addEventListener("focus", () => {
      counter.__focusEvents += 1;
    });
    // the event TanStack v5's focus manager actually listens to: it refetches
    // when the document becomes visible
    document.addEventListener("visibilitychange", () => {
      counter.__visibilityEvents += 1;
      const native = nativeVisibility();
      counter.__nativeStates.push(native);
      if (native === "visible") counter.__visibleFlips += 1;
    });
    // the reader is a BACKGROUND tab. The headless runner never hides a tab,
    // so the document says so itself — TanStack's focus manager reads
    // document.visibilityState, and the interval only runs in a hidden
    // document when refetchIntervalInBackground is set. Without this, the
    // spec would stay green with that flag deleted, and the ticket's
    // central claim would be pinned nowhere but an option object.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  const salesBefore = await readSalesCount(reader);

  // window A sells: the scan picks the item up, the cart takes one unit
  await page.bringToFront();
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sale-lines")).toBeVisible();
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved")).toBeVisible();

  // window B is never touched from here on: no click, no reload, no focus.
  // the numbers must still move.
  const startedAt = performance.now();
  await expect(async () => {
    expect(await readSalesCount(reader)).toBe(salesBefore + 1);
  }).toPass({ timeout: 20_000 });
  const elapsedMs = Math.round(performance.now() - startedAt);

  // the stock on hand moved too: the item is on the low-stock list with the
  // stock the sale left behind
  const lowStockRow = reader.getByTestId("dashboard-low-stock-list").getByRole("listitem").filter({ hasText: itemName });
  await expect(lowStockRow).toContainText("5 / 5");

  // the focus path did not do this: window B never became visible, so
  // TanStack's focus manager never refetched it, and it was a background tab
  // while the numbers moved.
  //
  // The counters read the BROWSER's own visibility state, not the patched one
  // the app sees: a counter that read the patched getter could never count
  // anything, because every event would read "hidden" and the assertion
  // could not fail (test-audit finding 6).
  const readerEvents = await reader.evaluate(() => {
    // SAFETY: see above — the page installed the counters before the test read them
    const counter = window as Window & {
      __focusEvents: number;
      __visibilityEvents: number;
      __visibleFlips: number;
      __nativeStates: string[];
    };
    return {
      focusEvents: counter.__focusEvents,
      visibilityEvents: counter.__visibilityEvents,
      visibleFlips: counter.__visibleFlips,
      nativeStates: counter.__nativeStates,
    };
  });
  // the browser's own state, for the record
  const nativeVisibility = await reader.evaluate(() => {
    const getter = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get;
    return getter?.call(document) ?? "unknown";
  });
  // the app's own view of the reader: hidden. This is the proof, and it is
  // stronger than the counters — with the reader hidden, the focus manager
  // sees `isFocused() === false` and the interval only runs because
  // refetchIntervalInBackground says so.
  const visibility = await reader.evaluate(() => document.visibilityState);
  expect(visibility).toBe("hidden");
  // the reader was never seen visible: no visibilitychange ever found it
  // visible, so the focus path had nothing to refetch on
  expect(readerEvents.visibleFlips).toBe(0);
  // and it never took focus. The counter is installed after goto(), so it
  // counts the focus events that arrive from here on — this test never
  // clicks the reader.
  expect(readerEvents.focusEvents).toBe(0);
  const measurement = `converged in ${elapsedMs}ms; reader visibility=${visibility} (browser says ${nativeVisibility}), focus events=${readerEvents.focusEvents}, visibility events=${readerEvents.visibilityEvents}, visible flips=${readerEvents.visibleFlips}, native states=${readerEvents.nativeStates.join(",")}`;
  // the measurement is the point of the spec: it lands in the test output
  console.log(`#295 measurement: ${measurement}`);
  testInfo.annotations.push({ type: "measurement", description: measurement });
});
