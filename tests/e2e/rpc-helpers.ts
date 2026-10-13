import { expect, type Page, type Response } from "@playwright/test";

/**
 * Server-acknowledged writes (issue 179).
 *
 * Every oRPC procedure is POSTed to `/api/rpc/<procedure>` and answers
 * `{ json: <output> }` on success. A spec that must observe the effect of a
 * write awaits this acknowledgement instead of polling the UI inside
 * Playwright's default 5 s `expect` window: under CI load the write can land
 * after the poll has already given up even though nothing is broken.
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
 * Run `action` and return only after its write was accepted by the server.
 * Arm-then-act in one call so the wait can never be set up after the request.
 */
export async function actAndAck(page: Page, procedure: string, action: () => Promise<void>): Promise<Response> {
  const ack = waitForRpc(page, procedure);
  await action();
  return expectRpcOk(ack, procedure);
}

/** The oRPC success envelope; `json` carries the procedure's declared output. */
export async function rpcOutput<T>(response: Response): Promise<T> {
  // SAFETY: the oRPC fetch link (StandardRPCSerializer) answers a successful
  // procedure call with the `{ json: <declared output> }` envelope; the caller's
  // T names that output, and expectRpcOk already rejected a refusal.
  const body = (await response.json()) as { json: T };
  return body.json;
}
