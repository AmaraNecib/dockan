import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";

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
 * HOW THE TICK IS PROVEN, not the focus event. TanStack v5's focus manager
 * listens to `visibilitychange`, not `focus`: it refetches when the document
 * becomes visible. So the counter that matters is the number of
 * visibility-changes that made the reader VISIBLE — zero means the focus path
 * never fired, and with no reload, no interaction and no mutation in the
 * reader window, the bounded tick is the only refetch trigger left. The
 * elapsed time is reported as a measurement, not asserted as a bound: the
 * tick's phase relative to the sale is arbitrary, so a fast convergence would
 * not mean a focus refetch happened.
 *
 * The numbers that must move are the two hot counters: today's sales (the
 * count on the dashboard card) and the stock on hand (the item's row in the
 * low-stock list, which only shows once the sale pushes it under its
 * threshold).
 */

/** The seed RPCs this spec sends over the session's authenticated wire. */
type SeedRequest =
  | { procedure: "categoriesList"; input: Record<string, never> }
  | {
      procedure: "itemsCreateWithStock";
      input: {
        name: string;
        categoryId: string;
        costPrice: number;
        sellingPrice: number;
        lowStockThreshold: number;
        barcode: string;
        stockOnHand: number;
      };
    };

/** Call one oRPC procedure from the page and return its declared output. */
async function rpc<T>(page: Page, request: SeedRequest): Promise<T> {
  const result = await page.evaluate(async ({ procedure: name, input: body }: SeedRequest) => {
    const response = await fetch(`/api/rpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    });
    if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}`);
    // SAFETY: the oRPC fetch link answers a successful procedure call with the
    // `{ json: <declared output> }` envelope; the caller's T names it
    const answer = (await response.json()) as { json: unknown };
    return answer.json;
  }, request);
  // SAFETY: see above
  return result as T;
}

/** The sales count on the dashboard card, read from the rendered text. */
async function readSalesCount(page: Page): Promise<number> {
  const text = (await page.getByTestId("dashboard-sales-today").textContent()) ?? "";
  const match = /عدد فواتير البيع: (\d+)/.exec(text);
  if (match === null) throw new Error(`no sales count on the card: ${text}`);
  return Number(match[1]);
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
  const categories = await rpc<{ items: Array<{ id: string }> }>(page, { procedure: "categoriesList", input: {} });
  await rpc(page, {
    procedure: "itemsCreateWithStock",
    input: {
      name: itemName,
      categoryId: categories.items[0]!.id,
      costPrice: 100,
      sellingPrice: 200,
      lowStockThreshold: 5,
      barcode,
      stockOnHand: 6,
    },
  });

  // window B: a second tab in the same session, and counters for the events
  // it must not receive
  const reader = await context.newPage();
  await reader.goto("/");
  await expect(reader.getByTestId("dashboard-page")).toBeVisible();
  await reader.evaluate(() => {
    // SAFETY: the page installs these counters on its own window and reads
    // them back later in the same test; the cast names the properties it added
    const counter = window as Window & { __focusEvents: number; __visibleFlips: number };
    counter.__focusEvents = 0;
    counter.__visibleFlips = 0;
    window.addEventListener("focus", () => {
      counter.__focusEvents += 1;
    });
    // the event TanStack v5's focus manager actually listens to: it refetches
    // when the document becomes visible
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") counter.__visibleFlips += 1;
    });
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

  // the focus path did not do this: window B never became visible again, so
  // TanStack's focus manager never refetched it, and it was a background tab
  // while the numbers moved
  const readerEvents = await reader.evaluate(() => {
    // SAFETY: see above — the page installed the counters before the test read them
    const counter = window as Window & { __focusEvents: number; __visibleFlips: number };
    return { focusEvents: counter.__focusEvents, visibleFlips: counter.__visibleFlips };
  });
  const visibility = await reader.evaluate(() => document.visibilityState);
  expect(readerEvents.visibleFlips).toBe(0);
  const measurement = `converged in ${elapsedMs}ms; reader visibility=${visibility}, focus events=${readerEvents.focusEvents}, visibility flips=${readerEvents.visibleFlips}`;
  // the measurement is the point of the spec: it lands in the test output
  console.log(`#295 measurement: ${measurement}`);
  testInfo.annotations.push({ type: "measurement", description: measurement });
});
