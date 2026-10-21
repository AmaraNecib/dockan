/**
 * The outbound RPC request the e2e helpers post (#295).
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE HELPER. The e2e helpers used to
 * build their own request inside the page, and the only proof that the
 * request carried the app's link headers (`x-vault-session`) and its
 * `credentials: "include"` was a COMMENT. A comment is not a pin: deleting
 * the header line left every test green, and the failure would only show up
 * on a vault-mode server, where the seed RPC is refused for a reason that has
 * nothing to do with what the spec is testing.
 *
 * So the request is built HERE, in one place, and the browser-side fetch is
 * a function that takes that request as an argument. A unit test can then
 * call the very function the helper calls and look at what it would send.
 *
 * The vault token is no longer the only credential a seeded call can present.
 * Since #319 the browser path carries the vault session in an `HttpOnly`
 * cookie this page cannot read, and `credentials: "include"` below is what
 * sends it; the storage key the helper still reads is the pre-#319 location
 * and now reads as absent. A token passed in is still attached as the header,
 * which is the transport a non-browser client uses.
 */

/**
 * The storage key the app's vault client USED to write the session token to
 * (`apps/web/src/lib/vault-client.ts`). Since #319 nothing writes it: the
 * browser path's credential is an `HttpOnly` cookie, and the cookie is what
 * authenticates a seeded call. Kept so the helper's read and this constant
 * cannot drift; removing the read is a follow-up.
 */
export const VAULT_SESSION_STORAGE_KEY = "dokan.vault.session";

/**
 * The headers the RPC request carries.
 *
 * A named owner contract, not `Record<string, string>` at every use: the
 * header names are the app's own, and the session header is optional.
 */
export interface RpcRequestHeaders {
  [header: string]: string;
}

/** The request the helper posts: its headers and its credentials mode. */
export interface RpcRequestInit {
  readonly headers: RpcRequestHeaders;
  readonly credentials: "include";
}

/**
 * The request init for one RPC call.
 *
 * The vault session header is attached only when a token is configured: an
 * empty or absent token means "no session", and an empty header value is not
 * the same thing as no header at all — the server reads the header, and an
 * empty one is a wrong answer rather than an absent one.
 *
 * `credentials: "include"` is the app's own mode (the web client's fetch
 * link sends the session cookie the same way), so a seeded call is
 * authenticated exactly like a call the page made.
 */
export function rpcRequestInit(vaultToken: string | null): RpcRequestInit {
  const headers: RpcRequestHeaders = { "content-type": "application/json" };
  if (vaultToken !== null && vaultToken !== "") headers["x-vault-session"] = vaultToken;
  return { headers, credentials: "include" };
}

/** One RPC call, as the page receives it. */
export interface RpcPageRequest {
  /** the procedure name, which is the last path segment of the endpoint */
  readonly name: string;
  /** the request body, already serialized by the caller */
  readonly payload: string;
  readonly init: RpcRequestInit;
}

/**
 * The oRPC envelope the endpoint answers: the output under `json`.
 *
 * The output type is the caller's, so the helper can hand back a typed value
 * once it has checked the envelope really carries one.
 */
export interface RpcEnvelope<TOutput> {
  readonly json: TOutput;
}

/**
 * The fetch the helper performs, in the page.
 *
 * SELF-CONTAINED ON PURPOSE: `page.evaluate` serializes this function's
 * source into the browser, so it may not close over anything in this module
 * — no imports, no module scope. Everything it needs arrives as arguments.
 */
export async function postRpcInPage<TOutput>(request: RpcPageRequest): Promise<RpcEnvelope<TOutput>> {
  const response = await fetch(`/api/rpc/${request.name}`, {
    method: "POST",
    headers: new Headers(request.init.headers),
    body: request.payload,
    credentials: request.init.credentials,
  });
  if (!response.ok) {
    // the status says a call was REFUSED; only the body says why. A seed that
    // fails for a reason the spec cannot read is a failure with no cause — and
    // the api's refusals (a missing category, a vault session) name the thing
    // that was wanted, so hand that text on rather than swallowing it
    const detail = await response.text().catch(() => "");
    throw new Error(`${request.name} failed with HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  // SAFETY: the oRPC link answers the parsed JSON body of the call, and the
  // caller names the output type it expects under `json`.
  return (await response.json()) as RpcEnvelope<TOutput>;
}
