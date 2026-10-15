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

/**
 * Read an armed ack's body and unwrap the `{ json }` envelope.
 *
 * The `.then` is attached to the *armed promise*, not to an awaited response,
 * so `response.json()` runs as soon as the headers land. Playwright throws
 * `Network.getResponseBody: No resource with given identifier found — Response
 * body is not available for a response that was navigated away from` when a
 * body is read after a navigation discarded it, so this is the safe default for
 * every caller. (A read the page issues *around* a `page.goto` still belongs in
 * `readRpc` below: there the matching response can come from the document being
 * replaced, and even an eager read races the protocol round-trip.)
 */
function readEnvelope<T>(ack: Promise<Response>, procedure: string): Promise<T> {
  return ack.then(async (response) => {
    expect(response.ok(), `${procedure} failed with HTTP ${response.status()}`).toBe(true);
    // SAFETY: the oRPC fetch link (StandardRPCSerializer) answers a successful
    // procedure call with the `{ json: <declared output> }` envelope; the
    // caller's T names that output, and `ok()` was already asserted above.
    const body = (await response.json()) as { json: T };
    return body.json;
  });
}

/**
 * Run `action` and return the server-acknowledged output of the RPC it
 * triggered. Arm-then-act in one call so the wait can never be set up after the
 * request, and read the body eagerly so a later navigation cannot discard it.
 */
export async function actAndAck<T = unknown>(
  page: Page,
  procedure: string,
  action: () => Promise<void>,
): Promise<T> {
  const output = readEnvelope<T>(waitForRpc(page, procedure), procedure);
  try {
    await action();
  } catch (error) {
    // the action failed before its request could be matched; swallow the armed
    // read so its teardown rejection cannot mask the real failure
    void output.catch(() => undefined);
    throw error;
  }
  return output;
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
  // SAFETY: both create procedures declare the item output, which carries the
  // server-issued id the line is keyed on.
  const created = await actAndAck<{ id: string }>(page, options.procedure, async () => {
    await options.save.click();
    await expect(options.error).toHaveCount(0);
  });
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
  // T names that output, and the caller already rejected a refusal.
  const body = (await response.json()) as { json: T };
  return body.json;
}

/**
 * Read a procedure's output directly, with no response for a navigation to
 * discard.
 *
 * `actAndAck` is right for RPCs the page issues in response to an action that
 * does not navigate. A *read* the page issues on mount (e.g. `customersList`
 * after `page.goto`) is different: arming an ack before the `goto` can match a
 * response issued by the document being replaced, and Playwright then refuses
 * to hand over that body — "No resource with given identifier found …
 * navigated away from". Awaiting the navigation and reading through
 * `page.evaluate` asks the same endpoint for the same value with no
 * navigation-raceable body.
 *
 * `/api/rpc/<procedure>` accepts an empty JSON body for a no-input procedure
 * and answers the same `{ json }` envelope the page's client reads, so this is
 * the server value the UI renders.
 */
export async function readRpc<T>(page: Page, procedure: string): Promise<T> {
  const envelope = await page.evaluate(async (name) => {
    const response = await fetch(`/api/rpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "include",
    });
    if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}`);
    // SAFETY: the oRPC endpoint answers a successful procedure call with the
    // `{ json: <declared output> }` envelope; `ok()` was asserted just above.
    return (await response.json()) as { json: unknown };
  }, procedure);
  // SAFETY: page.evaluate cannot carry a generic across the browser boundary,
  // so the envelope's `json` is named by the caller's T; the shape was just
  // checked to be the oRPC envelope.
  return envelope.json as T;
}
