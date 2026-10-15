import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./auth-helpers";
import { actAndAck } from "./rpc-helpers";

/**
 * Issue #209 review (round 3) — `actAndAck` arms the ack **before** it runs the
 * action, so the server can refuse the RPC while the action is still in flight.
 * The helper now attaches a rejection handler at that moment; see the comment
 * at its `void output.catch(...)`. These tests pin the two halves of the
 * contract: the action's error is what surfaces and no rejection is reported
 * unhandled, while a refusal the action does not outlive is still reported by
 * the awaited call.
 */

/** One event-loop turn is enough for a rejection report to be emitted. */
const SETTLE_MS = 50;

/** A throwaway customer name; the refusals below never write it. */
const customerName = (suffix: string): string => `مراجعة-209-${suffix}-${Date.now()}`;

/** Record process-level unhandled rejections for the duration of a test. */
function trackUnhandledRejections() {
  const unhandled: string[] = [];
  const track = (reason: Error | string): void => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", track);
  return { unhandled, stop: () => process.off("unhandledRejection", track) };
}

/**
 * Make `customersCreate` answer 500. Returns the matched URL and how many times
 * the fixture actually answered: asserting that count makes the mock
 * self-verifying, so a URL that stops matching fails the test instead of
 * letting the real server write a throwaway customer into the shared database.
 */
async function refuseCustomersCreate(
  page: Page,
): Promise<{ rpcUrl: RegExp; refused: () => number }> {
  const rpcUrl = /\/api\/rpc\/customersCreate$/;
  let refused = 0;
  await page.route(rpcUrl, (route) => {
    refused += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ json: { code: "REFUSED", message: "round-3 fixture" } }),
    });
  });
  return { rpcUrl, refused: () => refused };
}

/** Open the new-customer dialog on the list route. */
async function openNewCustomerForm(page: Page): Promise<void> {
  await signIn(page);
  await page.goto("/customers");
  await page.getByTestId("party-new").click();
}

test("actAndAck reports the action error, not a refused RPC, with no unhandled rejection", async ({
  page,
}) => {
  await openNewCustomerForm(page);
  const { rpcUrl, refused } = await refuseCustomersCreate(page);
  const { unhandled, stop } = trackUnhandledRejections();
  try {
    let thrown: Error | undefined;
    try {
      await actAndAck(page, "customersCreate", async () => {
        // observe the refusal independently of the helper, so the action cannot
        // finish before the armed read has had a chance to reject
        const refusal = page.waitForResponse(rpcUrl);
        await page.getByTestId("party-form-name").fill(customerName("action"));
        await page.getByTestId("party-form-phone").fill("0567000000");
        await page.getByTestId("party-form-save").click();
        await refusal;
        // one turn past the refusal: pre-fix this is when Node reports the armed
        // read unhandled (it has no handler until the action ends)
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        throw new Error("ACTION_FAILED");
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown?.message).toBe("ACTION_FAILED");
    expect(refused()).toBe(1);
    // one more turn so a delayed rejection report surfaces before asserting
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(unhandled, `unhandled rejections: ${unhandled.join(" | ")}`).toEqual([]);
  } finally {
    stop();
    await page.unroute(rpcUrl);
  }
});

test("actAndAck still reports a refused RPC when the action completes", async ({ page }) => {
  await openNewCustomerForm(page);
  const { rpcUrl, refused } = await refuseCustomersCreate(page);
  try {
    // The early handler must not consume the rejection: with no action error,
    // the refused RPC is the one the awaited call reports.
    await expect(
      actAndAck(page, "customersCreate", async () => {
        await page.getByTestId("party-form-name").fill(customerName("refused"));
        await page.getByTestId("party-form-phone").fill("0567000001");
        await page.getByTestId("party-form-save").click();
      }),
    ).rejects.toThrow("customersCreate failed with HTTP 500");
    expect(refused()).toBe(1);
  } finally {
    await page.unroute(rpcUrl);
  }
});

test("actAndAck surfaces an action that throws before its RPC is issued", async ({ page }) => {
  await openNewCustomerForm(page);
  // No route and no RPC: the armed wait never matches. This is the path the
  // removed `catch` used to cover — the action error must still surface without
  // waiting for the ack's timeout or leaking a rejection when the page closes.
  await expect(
    actAndAck(page, "customersCreate", async () => {
      throw new Error("ACTION_FAILED_BEFORE_RPC");
    }),
  ).rejects.toThrow("ACTION_FAILED_BEFORE_RPC");
});
