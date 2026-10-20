import { expect, type Locator, type Page, type Response } from "@playwright/test";

import {
  postRpcInPage,
  rpcRequestInit,
  type RpcEnvelope,
  VAULT_SESSION_STORAGE_KEY,
} from "../../packages/e2e-support/src/rpc-request";

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
 * so `response.json()` runs as soon as the headers land. That makes the window
 * in which a later navigation can discard the body negligible, which is the
 * safe default for every `actAndAck` caller. It does not close that window
 * entirely: an action that navigates can still lose the body between the
 * headers and the body round-trip. Reads the page issues *around* a navigation
 * must use `readRpc` below, which has no response for a navigation to discard.
 */
export function readEnvelope<T>(ack: Promise<Response>, procedure: string): Promise<T> {
  return ack.then((response) => rpcOutput<T>(response, procedure));
}

/**
 * Run `action` and return the server-acknowledged output of the RPC it
 * triggered. Arm-then-act in one call so the wait can never be set up after the
 * request, and read the body eagerly so a later navigation cannot discard it.
 *
 * `action` must not navigate: a navigating read belongs in `readRpc`, whose
 * response cannot be lost to the document swap.
 */
export async function actAndAck<T = unknown>(
  page: Page,
  procedure: string,
  action: () => Promise<void>,
): Promise<T> {
  const output = readEnvelope<T>(waitForRpc(page, procedure), procedure);
  // Attach the rejection handler NOW: the action runs while the read is already
  // armed, so the server can refuse the RPC before the action ends. Without a
  // handler at that moment Node reports that refusal as an unhandled rejection
  // — a second failure that masks the action's own error. `output` keeps its
  // rejection (a second handler does not consume it), so a refusal the action
  // does not outlive is still what the awaited call reports.
  void output.catch(() => undefined);
  await action();
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

/**
 * The oRPC success envelope; `json` carries the procedure's declared output.
 *
 * `response` must be an accepted (2xx) ack: this fails loudly on a refusal and
 * on a body without the envelope, so a caller that reaches `json` reads the
 * server's value rather than a guess. `readEnvelope` is the eager-read wrapper
 * `actAndAck` uses; `procedure` labels the failure.
 */
export async function rpcOutput<T>(response: Response, procedure = "rpc"): Promise<T> {
  expect(response.ok(), `${procedure} failed with HTTP ${response.status()}`).toBe(true);
  // SAFETY: `response.json()` is untyped; the oRPC fetch link
  // (StandardRPCSerializer) answers a successful procedure call with the
  // `{ json: <declared output> }` envelope and `ok()` above rejected a refusal,
  // so the caller's T names the value at `json`.
  const body = (await response.json()) as { json: T };
  if (body === null || !Object.prototype.hasOwnProperty.call(body, "json")) {
    throw new Error(`${procedure}: unexpected oRPC envelope (no json field)`);
  }
  return body.json;
}

/**
 * POST one procedure from the page and unwrap the `{ json }` envelope.
 *
 * The request itself is built by `@dokan/e2e-support` (packages/e2e-support),
 * which owns the app's link headers (`x-vault-session`) and the
 * `credentials: "include"` mode — and a unit test over that module pins what
 * the request carries. This helper only has to supply the page's vault token
 * and the payload.
 */
async function postRpc<T>(page: Page, procedure: string, payload: string): Promise<T> {
  // the token lives in the PAGE's sessionStorage (the key the app's vault
  // client writes), so it is read there. A blocked storage throws there too
  // and must not fail the read.
  const vaultToken = await page.evaluate((key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      /* storage can be blocked by the webview; proceed without a vault session */
      return null;
    }
  }, VAULT_SESSION_STORAGE_KEY);
  const body = await page.evaluate(postRpcInPage, {
    name: procedure,
    payload,
    init: rpcRequestInit(vaultToken),
  });
  if (body === null || !Object.prototype.hasOwnProperty.call(body, "json")) {
    throw new Error(`${procedure}: unexpected oRPC envelope (no json field)`);
  }
  // SAFETY: page.evaluate cannot carry a generic across the browser boundary;
  // the oRPC StandardRPCSerializer answers a successful call with
  // `{ json: <declared output> }` (the browser-side `ok()` rejected a refusal),
  // so the caller's T names the value at `json`.
  return (body as RpcEnvelope<T>).json;
}

/**
 * Read a no-input procedure's output directly, with no response for a
 * navigation to discard.
 *
 * `actAndAck` is right for RPCs the page issues in response to an action that
 * does not navigate. A *read* the page issues on mount (e.g. `customersList`
 * after `page.goto`) is different: arming an ack before the `goto` can match a
 * response issued by the document being replaced, and Playwright then refuses
 * to hand over that body — "No resource with given identifier found …
 * navigated away from" — even with an eager read. Awaiting the navigation and
 * reading through `page.evaluate` asks the same endpoint for the same value
 * with no navigation-raceable body.
 *
 * `/api/rpc/<procedure>` accepts an empty JSON body for a no-input procedure
 * and answers the same `{ json }` envelope the page's client reads, so this is
 * the server value the UI renders.
 */
export async function readRpc<T>(page: Page, procedure: string): Promise<T> {
  return postRpc<T>(page, procedure, "{}");
}

/**
 * Call a procedure that TAKES an input from the page and return its output.
 *
 * The input-taking sibling of `readRpc`, and the shape a spec that seeds a
 * fixture through the app's own wire needs (`itemsCreateWithStock`). A spec
 * that hand-rolls this fetch is how the app's link headers get dropped: the
 * fourth private copy omitted `x-vault-session` and would have been refused on
 * a vault-mode server (#295). Both `postRpc` callers share the header now.
 */
export async function callRpc<T, I>(page: Page, procedure: string, input: I): Promise<T> {
  return postRpc<T>(page, procedure, JSON.stringify({ json: input }));
}

/**
 * A category to hang seeded items on, creating one when the shop has none.
 *
 * A spec cannot borrow a category from whatever ran before it. The api seeds the
 * default category once, at boot, and `scripts/reset-e2e-records.mjs` clears the
 * categories again — so a spec that runs after a reset (including the SAME spec
 * under `--repeat-each`, whose own afterAll reset fires between runs) reads
 * `categories.items[0]` as undefined and dies with a TypeError about the order
 * of the suite rather than about its own change. Both callers live here so the
 * two copies cannot drift.
 */
export async function seedCategoryId(page: Page, name: string): Promise<string> {
  // SAFETY: categoriesList answers { items: Array<{ id: string }> }
  const categories = await callRpc<{ items: Array<{ id: string }> }, Record<string, never>>(page, "categoriesList", {});
  const existing = categories.items[0];
  if (existing !== undefined) return existing.id;
  // SAFETY: categoriesCreate answers the created category, whose id is a string
  const created = await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name });
  return created.id;
}
