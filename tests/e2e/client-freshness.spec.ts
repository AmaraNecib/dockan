import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { runE2eReset } from "./reset-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";

/**
 * #295 — the v1 multi-client measurement (#294): two windows, one api.
 *
 * Window A sells. Window B is a second tab in the same browser session, left
 * alone for the whole test: it is never clicked, never focused, never
 * reloaded. The numbers it shows must still move.
 *
 * WHICH CASE IS THE TICKET'S, and why there are two tests. Two windows side by
 * side are both VISIBLE; only one has the keyboard. TanStack Query refetches a
 * stale query when the window regains focus, so a window the owner clicks into
 * catches up on its own — that path needs nothing from this ticket. It cannot
 * cover the visible-but-unfocused window, because the event it listens for
 * never arrives there (`@tanstack/query-core@5.101.4`
 * `build/modern/focusManager.js:12-15` registers `visibilitychange` only, and
 * `isFocused()` at `:55-60` answers from `document.visibilityState`). So:
 *
 *   1. "a sale in one window moves the hot counters in the other" — the
 *      ticket's own case, measured with NO patch and NO abstraction: the
 *      reader is visible and unfocused, and only the bounded tick can carry
 *      the change. Deleting the tick turns this test red.
 *   2. "a hidden reader converges too" — the same two windows with the
 *      reader's document pretending to be hidden, which is the ONE case
 *      `refetchIntervalInBackground` covers (a visible window ticks with or
 *      without the flag). Deleting the flag turns this test red and leaves
 *      test 1 green, which is the honest shape of the mechanism.
 *
 * HOW THE TICK IS PROVEN, not the focus event. The counters read the BROWSER's
 * own visibility state (`Document.prototype`'s getter), never the patched
 * instance one, so they can contradict the app; a counter reading the
 * pretended state could never fail. In test 1 the assertion is that the
 * browser says `visible` — the reader WAS an on-screen window — and that no
 * `visibilitychange` and no `focus` event ever reached it. With no reload, no
 * interaction and no mutation in the reader window, the bounded tick is the
 * only refetch trigger left. The elapsed time is reported as a measurement,
 * not asserted as a bound: the tick's phase against the sale is arbitrary, so
 * a fast convergence would not mean a focus refetch happened.
 *
 * The numbers that must move are the two hot counters: today's sales (the
 * count on the dashboard card) and the stock on hand (the item's row in the
 * low-stock list, which only shows once the sale pushes it under its
 * threshold).
 */

// The items and the sales this spec seeds join the shared e2e database, so it
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

/** The browser's own document state, read from the prototype getter. */
async function nativeVisibility(page: Page): Promise<string> {
  return page.evaluate(() => {
    const getter = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get;
    return getter?.call(document) ?? "unknown";
  });
}

// The reader page installs these counters on its own window (openReader) and
// reads them back in the same test (readCounters); the globals live only while
// those windows are alive, so they belong to this spec alone.
declare global {
  interface Window {
    __focusEvents: number;
    __visibilityEvents: number;
    __visibleFlips: number;
    __nativeStates: string[];
  }
}

type ReaderCounters = {
  focusEvents: number;
  visibilityEvents: number;
  visibleFlips: number;
  nativeStates: string[];
};

/**
 * One item with 6 in stock against a threshold of 5, so a single sale leaves 5
 * and the item enters the dashboard's low-stock list.
 */
async function seedItem(page: Page, stamp: string): Promise<string> {
  // a category is created when the shop has none: this spec's own afterAll
  // reset clears them, so a second run (`--repeat-each`) or any spec after a
  // reset would otherwise read `categories.items[0]` as undefined and fail on
  // the order of the suite rather than on freshness.
  const categoryId = await seedCategoryId(page, `تصنيف-نضارة-${stamp}`);
  const payload: SeedItem = {
    name: `نضارة-${stamp}`,
    categoryId,
    costPrice: 100,
    sellingPrice: 200,
    lowStockThreshold: 5,
    barcode: `FRESH${stamp}`,
    stockOnHand: 6,
  };
  await callRpc<{ id: string }, SeedItem>(page, "itemsCreateWithStock", payload);
  return payload.name;
}

/**
 * Window B: a second tab in the same session, plus the counters for the events
 * it must not receive. `pretendHidden` shadows `document.visibilityState` on
 * this instance, which is what TanStack's focus manager reads when the page
 * has to stand in for a minimized window.
 */
async function openReader(context: BrowserContext, opts: { pretendHidden: boolean }): Promise<Page> {
  const reader = await context.newPage();
  await reader.goto("/");
  await expect(reader.getByTestId("dashboard-page")).toBeVisible();
  await reader.evaluate((pretendHidden: boolean) => {
    // The reader's OWN visibility state, read from the prototype rather than
    // from the document. The patch below shadows `document.visibilityState`
    // on this instance, so a counter that read the document would always
    // read "hidden" and could never count anything — the counter has to see
    // what the BROWSER says, which is the only thing that can contradict it.
    const nativeVisibility = (): string => {
      const getter = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get;
      return getter?.call(document) ?? "unknown";
    };
    // SAFETY: the page installs these counters on its own window and reads
    // them back later in the same test; the globals above name them
    const counter = window;
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
    if (pretendHidden) {
      // the reader stands in for a minimized window. The interval only runs
      // there because `refetchIntervalInBackground` is set; a visible window
      // needs no flag at all (`isFocused()` is true for it).
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    }
  }, opts.pretendHidden);
  return reader;
}

async function readCounters(reader: Page): Promise<ReaderCounters> {
  return reader.evaluate(() => {
    // SAFETY: see openReader — the page installed the counters before the test read them
    const counter = window;
    return {
      focusEvents: counter.__focusEvents,
      visibilityEvents: counter.__visibilityEvents,
      visibleFlips: counter.__visibleFlips,
      nativeStates: counter.__nativeStates,
    };
  });
}

/** Window A sells one unit by scanning the barcode. */
async function sellOne(page: Page, barcode: string): Promise<void> {
  await page.bringToFront();
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sale-lines")).toBeVisible();
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved")).toBeVisible();
}

test("a sale in one window moves the hot counters in the other, with no reload", async ({ page, context }, testInfo) => {
  // the convergence waits for a tick, so the default 30s budget is too tight
  test.setTimeout(90_000);

  await signIn(page);

  const stamp = `visible-${Date.now().toString()}`;
  const itemName = await seedItem(page, stamp);

  // window B: NOT patched. This is the ticket's case as it really is — a
  // second on-screen window that never gets the keyboard.
  const reader = await openReader(context, { pretendHidden: false });
  const salesBefore = await readSalesCount(reader);

  await sellOne(page, `FRESH${stamp}`);

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

  const events = await readCounters(reader);
  const native = await nativeVisibility(reader);
  const visibility = await reader.evaluate(() => document.visibilityState);

  // THE PREMISE, asserted: the reader is a VISIBLE window, not a hidden tab.
  // If the runner ever hid it, this test would be measuring the flag's case
  // and the claim below would be false.
  expect(native).toBe("visible");
  expect(visibility).toBe("visible");

  // the focus path did not do this: window B never took focus, and no
  // `visibilitychange` ever reached it — for a window that is already visible
  // there is no flip to observe, which is exactly why `refetchOnWindowFocus`
  // cannot carry this case.
  expect(events.visibleFlips).toBe(0);
  expect(events.visibilityEvents).toBe(0);
  expect(events.focusEvents).toBe(0);

  const measurement = `converged in ${elapsedMs}ms; reader visible and unfocused (browser says ${native}), focus events=${events.focusEvents}, visibility events=${events.visibilityEvents}, visible flips=${events.visibleFlips}`;
  // the measurement is the point of the spec: it lands in the test output
  console.log(`#295 measurement [visible-unfocused]: ${measurement}`);
  testInfo.annotations.push({ type: "measurement", description: measurement });
});

test("a hidden reader converges too, which is what refetchIntervalInBackground buys", async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);

  await signIn(page);

  const stamp = `hidden-${Date.now().toString()}`;
  const itemName = await seedItem(page, stamp);

  // window B, standing in for a minimized window. The headless runner never
  // hides a tab, so the page pretends; without the pretence this test would
  // repeat the one above and the background flag would be pinned only by an
  // option object.
  const reader = await openReader(context, { pretendHidden: true });
  const salesBefore = await readSalesCount(reader);

  await sellOne(page, `FRESH${stamp}`);

  const startedAt = performance.now();
  await expect(async () => {
    expect(await readSalesCount(reader)).toBe(salesBefore + 1);
  }).toPass({ timeout: 20_000 });
  const elapsedMs = Math.round(performance.now() - startedAt);

  const lowStockRow = reader.getByTestId("dashboard-low-stock-list").getByRole("listitem").filter({ hasText: itemName });
  await expect(lowStockRow).toContainText("5 / 5");

  const events = await readCounters(reader);
  const native = await nativeVisibility(reader);
  const visibility = await reader.evaluate(() => document.visibilityState);

  // the app's view of the reader is hidden, and the browser's is not: that
  // gap is the point. With the document hidden, `isFocused()` is false and the
  // interval runs only because the flag says so — delete the flag and this
  // test goes red while the visible-unfocused one stays green.
  expect(visibility).toBe("hidden");
  expect(native).toBe("visible");
  expect(events.visibleFlips).toBe(0);
  expect(events.focusEvents).toBe(0);

  const measurement = `converged in ${elapsedMs}ms; reader hidden to the app (browser says ${native}), focus events=${events.focusEvents}, visibility events=${events.visibilityEvents}, visible flips=${events.visibleFlips}`;
  console.log(`#295 measurement [hidden]: ${measurement}`);
  testInfo.annotations.push({ type: "measurement", description: measurement });
});
