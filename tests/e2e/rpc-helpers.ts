import { expect, type Locator, type Page, type Response } from "@playwright/test";

/**
 * Server-acknowledged RPCs (issue 179).
 *
 * Every oRPC procedure is POSTed to `/api/rpc/<procedure>` and answers
 * `{ json: <output> }` on success. A spec that must observe the effect of a
 * write — or the result of a server-side read it just triggered — awaits this
 * acknowledgement instead of polling the UI inside Playwright's default 5 s
 * `expect` window: under CI load the round-trip can land after the poll has
 * already given up even though nothing is broken.
 */

/** Resolve on the POST response for one procedure. Arm this BEFORE the click. */
export function waitForRpc(page: Page, procedure: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/rpc/${procedure}`,
  );
}

/** Await an armed acknowledgement and fail loudly when the server refused it. */
export async function expectRpcOk(response: Promise<Response>, procedure: string): Promise<Response> {
  const resolved = await response;
  expect(resolved.ok(), `${procedure} failed with HTTP ${resolved.status()}`).toBe(true);
  return resolved;
}

/**
 * Run `action` and return only after the RPC it triggered was accepted by the
 * server. Arm-then-act in one call so the wait can never be set up after the
 * request.
 */
export async function actAndAck(page: Page, procedure: string, action: () => Promise<void>): Promise<Response> {
  const ack = waitForRpc(page, procedure);
  try {
    await action();
  } catch (error) {
    // the action failed before its request could be matched; swallow the armed
    // wait so its teardown rejection cannot mask the real failure
    void ack.catch(() => undefined);
    throw error;
  }
  return expectRpcOk(ack, procedure);
}

/**
 * The create procedures a quick-add form can call. The sale form routes a
 * positive opening quantity to `itemsCreateWithStock` and a blank one to
 * `itemsCreate`; the purchase form only ever calls `itemsCreate`.
 */
export type QuickAddProcedure = "itemsCreateWithStock" | "itemsCreate";

/** The form state a quick-add save must observe around its click (issue 196). */
export interface QuickAddSave {
  /**
   * The procedure the form actually calls for THIS spec's inputs. Arming the
   * wrong one never fires and hangs the whole test budget by construction (#191).
   */
  procedure: QuickAddProcedure;
  /** The quick-add form's save control; asserted enabled before the click. */
  save: Locator;
  /** Where the form records a synchronous client-side refusal. */
  error: Locator;
  /** The line table the created item lands in. */
  lines: Locator;
  /** The created item's name; scopes the line-key assertion. */
  itemName: string;
  /** The line-quantity input's aria-label suffix ("الكمية"). */
  quantityLabel: string;
}

/**
 * Save a quick-add form and return only after the item write it triggered was
 * accepted by the server. Returns the server-issued item id.
 *
 * This is the #191 shape, extracted so every quick-add site fails by name
 * instead of as an anonymous 30 s `waitForResponse` timeout:
 *
 * 1. the save control must be enabled before the click — a disabled save never
 *    sends the request the ack waits for;
 * 2. inside the action, no client-side refusal may have been recorded — the
 *    form refuses synchronously (unpicked category, rejected stock, bad price)
 *    and sends nothing, which would otherwise leave the armed ack hanging;
 * 3. the line the form lands is keyed on the id the create actually issued
 *    (`name="quantity-<id>"`), so "the item exists" is a server fact rather
 *    than a render guess.
 */
export async function saveQuickAdd(page: Page, options: QuickAddSave): Promise<{ id: string }> {
  await expect(options.save).toBeEnabled();
  const created = await rpcOutput<{ id: string }>(
    await actAndAck(page, options.procedure, async () => {
      await options.save.click();
      // SAFETY: both create procedures declare the item output, which carries
      // the server-issued id the line is keyed on.
      await expect(options.error).toHaveCount(0);
    }),
  );
  await expect(options.lines.getByLabel(`${options.itemName}: ${options.quantityLabel}`)).toHaveAttribute(
    "name",
    `quantity-${created.id}`,
  );
  return created;
}

/** The oRPC success envelope; `json` carries the procedure's declared output. */
export async function rpcOutput<T>(response: Response): Promise<T> {
  // SAFETY: the oRPC fetch link (StandardRPCSerializer) answers a successful
  // procedure call with the `{ json: <declared output> }` envelope; the caller's
  // T names that output, and expectRpcOk already rejected a refusal.
  const body = (await response.json()) as { json: T };
  return body.json;
}
