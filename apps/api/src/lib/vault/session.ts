/**
 * The vault session credential and the transports that can carry it (#319).
 *
 * The API keeps exactly ONE live session token: `VaultManager.mintSession`
 * always rotates it, so a token dies at the next unlock and on lock. This
 * module decides HOW a request presents that one token, and it is the only
 * place that decides — the vault routes and the RPC guard both ask it.
 *
 * Two transports, told apart by the SERVER's mode. The mode decides what a
 * request may present:
 *
 * - The browser path carries the token in an `HttpOnly` cookie. A cookie jar
 *   is shared by every window of the browser, so one unlock serves them all,
 *   and the web app's JavaScript never holds the secret.
 * - The broker path carries it in the `x-vault-session` header, because there
 *   the secret crosses the native bridge by design.
 *
 * Why the mode decides: a broker-mode server is the packaged desktop, whose
 * whole promise is that the credential never crosses the network. A page that
 * happens to hold a cookie (the same host, another port — cookies are
 * port-agnostic) must therefore never be able to present itself as the native
 * transport. So a broker-mode server reads the header and ignores the cookie
 * entirely.
 *
 * A browser-mode server reads the cookie AND still reads the header, for the
 * clients that legitimately hold a token (the dev tooling and the e2e
 * helpers). The mode picks which transports are readable; the request decides
 * which of them it actually uses.
 */

/** The cookie the browser path carries the vault session in. */
export const VAULT_SESSION_COOKIE_NAME = "dokan.vault.session";

/** The header the broker/native transport carries the vault session in. */
export const VAULT_SESSION_HEADER_NAME = "x-vault-session";

/** Which transport a credential arrived on. */
export type VaultCredentialCarrier = "cookie" | "header";

export type VaultCredentialResolution =
  /** The request carries no credential this server accepts. */
  | { kind: "none" }
  /**
   * The request carries at least one credential; whether it is LIVE is the
   * caller's call. `tokens` is plural because a jar can present several cookies
   * of this name, and any one of them may be the live session (see
   * `readVaultSessionCookies`). The caller tests every one against the single
   * live token the manager holds — never against a set.
   */
  | { kind: "credential"; tokens: readonly string[]; carrier: VaultCredentialCarrier }
  /**
   * The request carries the vault cookie from an origin this server refuses.
   * `SameSite=Strict` already keeps a cross-site request from carrying the
   * cookie at all; this is the server-level half, for a same-site page on
   * another port, which presents one anyway.
   */
  | { kind: "refused"; reason: "foreign-origin" };

/** The body a minting route returns: the token only on the broker path. */
export type VaultSessionBody = { sessionToken?: string; sessionGeneration: number };

/** What a minting route returns: its body, and the header that carries the cookie. */
export type VaultSessionPayload = { body: VaultSessionBody; headers: Record<string, string> };

/**
 * The host names that are loopback for the cookie rules: a `localhost` host is
 * a secure context, so Chrome and Firefox accept a `Secure` cookie over plain
 * HTTP, which is the only plain-HTTP origin this app is ever served from.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

/** A URL's host, or undefined when the text is not a URL this server can place. */
function urlOf(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * Whether the request's own origin qualifies for a `Secure` cookie: HTTPS, or a
 * loopback host (a secure context either way).
 */
export function secureOrigin(request: Request): boolean {
  const url = urlOf(request.url);
  if (url === undefined) return false;
  if (url.protocol === "https:") return true;
  return isLoopbackHost(url.hostname);
}

/**
 * The host (host AND port) the client actually addressed this server on.
 *
 * `request.url` is built from the `Host` header by the server adapter, so this is
 * the app's own origin as the caller saw it. What makes it trustworthy is a
 * property of BROWSERS, not of headers: a page cannot set `Host` on its own
 * requests, so the value it is judged against is one it could not choose. A
 * non-browser client can set `Host` freely — which is why this gate binds pages
 * and not local servers, and why the local-server replay is a separate, accepted
 * limit (ADR-0013, #343). An earlier version of this comment claimed the header
 * was one "the caller cannot restate", which is false and would tempt a reader to
 * trust the host somewhere it is only a header.
 *
 * `x-forwarded-host` is deliberately not consulted: that one a caller CAN set,
 * and honouring it would let a request declare the origin it wants judged against.
 *
 * The `undefined` arm is defensive, not reachable through a listener: a
 * `Request` cannot be built from a URL that does not parse, so the transport
 * refuses a malformed `Host` (400) before a request exists. It stays because
 * "a destination we cannot state is not our origin" is the rule, and the gate
 * must not grow a "no host, so let it through" branch later (#319 round 4).
 */
function addressedHost(request: Request): string | undefined {
  const url = urlOf(request.url);
  if (url === undefined) return undefined;
  return url.host.toLowerCase();
}

/** What the one origin gate decided about a request. */
export type VaultOriginVerdict = "same-origin" | "foreign-origin";

/**
 * THE origin gate — the single rule both seams call (#319, greptile P1).
 *
 * It answers "is this request's `Origin` this app's own origin", never "is it
 * a loopback origin". The weaker question was the hole: cookies ignore ports
 * and `SameSite=Strict` is scoped by site, so a page served from
 * `http://localhost:9999` — any other dev server, viewer or local tool on the
 * box — is same-site with the API, its `Origin` is a loopback origin, and its
 * no-preflight `POST` rode the live vault cookie. Only the origin the app is
 * actually served from matches now, and a different port on the same host is a
 * different origin.
 *
 * The rules, in order:
 *
 * 1. Broker mode always passes. The desktop webview's own scheme is not an
 *    http origin, the shell is the trusted party, and it presents the header
 *    rather than an ambient cookie — there is no cookie for another page to
 *    ride there.
 * 2. An absent Origin passes. A browser omits it on a GET, and the non-browser
 *    clients that legitimately present a token (curl, the e2e helpers) send
 *    none; `SameSite=Strict` is what keeps a cross-site request from carrying
 *    the cookie in the first place.
 * 3. A present Origin must name the host this request was addressed to, or be
 *    refused. Only the scheme is not compared: the connection's scheme is what
 *    a TLS terminator decides, and host:port equality already pins the origin
 *    to this app, because no page can be served from `https://host:port` on a
 *    port that has no TLS listener.
 */
export function vaultOriginGate(request: Request, options: { broker: boolean }): VaultOriginVerdict {
  if (options.broker) return "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return "same-origin";
  const named = urlOf(origin);
  if (named === undefined) return "foreign-origin";
  if (named.protocol !== "http:" && named.protocol !== "https:") return "foreign-origin";
  const own = addressedHost(request);
  if (own === undefined) return "foreign-origin";
  return named.host.toLowerCase() === own ? "same-origin" : "foreign-origin";
}

/**
 * Every vault session cookie a request carries, in the order the jar presented
 * them. Empty list when it carries none.
 *
 * Plural, deliberately (#319 round 5). Browsers send duplicate-name cookies
 * LONGEST-PATH-FIRST (RFC 6265 §5.4), so a cookie planted on `Path=/api/vault`
 * arrives BEFORE the live one on `Path=/` — and any page served under that path
 * on this loopback host can set one, because cookies ignore ports. Taking the
 * first match refused a request whose live cookie sat in the same jar, and the
 * next unlock minted another `Path=/` cookie the planted one shadowed again, so
 * the owner was shut out until they cleared the jar by hand. The caller tests
 * every value against the ONE live token, so a planted value costs a comparison
 * and never access.
 *
 * An empty value is skipped rather than returned: `dokan.vault.session=` is a
 * cookie this server never wrote, and `""` is not a token to test.
 *
 * The token is base64url (`manager.ts` mints it), so it needs no
 * percent-decoding; a jar that carries a percent-encoded value is not one this
 * server wrote, and it simply fails the live-token test.
 */
export function readVaultSessionCookies(request: Request): readonly string[] {
  const header = request.headers.get("cookie");
  if (header === null || header === "") return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== VAULT_SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value !== "") values.push(value);
  }
  return values;
}

/** The attributes every vault session cookie carries. */
function cookieAttributes(request: Request, extra: readonly string[]): string {
  const attributes = ["HttpOnly", "SameSite=Strict", "Path=/"];
  if (secureOrigin(request)) attributes.push("Secure");
  return [...attributes, ...extra].join("; ");
}

/**
 * The `Set-Cookie` value that hands the session to a browser.
 *
 * `HttpOnly` keeps the secret out of JavaScript, `SameSite=Strict` is the
 * browser half of the loopback-only rule, `Path=/` lets the whole app carry it,
 * and the cookie is host-only (no `Domain`) so it never leaves the host it was
 * written for.
 */
export function vaultSessionCookie(request: Request, token: string): string {
  return `${VAULT_SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(request, [])}`;
}

/** The `Set-Cookie` value that takes the session back (logout). */
export function clearedVaultSessionCookie(request: Request): string {
  return `${VAULT_SESSION_COOKIE_NAME}=; ${cookieAttributes(request, ["Max-Age=0"])}`;
}

/**
 * The reply a minting route returns, for the transport this server uses
 * (#319).
 *
 * A browser-mode server puts the token in an `HttpOnly` cookie and leaves it
 * out of the body: the page must never be able to read it. A broker-mode server
 * returns it in the body and sets no cookie, because there the secret crosses
 * the native bridge by design and the webview's scheme is not a cookie host.
 */
export function vaultSessionPayload(
  broker: boolean,
  request: Request,
  token: string,
  generation: number,
): VaultSessionPayload {
  if (broker) return { body: { sessionToken: token, sessionGeneration: generation }, headers: {} };
  return {
    body: { sessionGeneration: generation },
    headers: { "set-cookie": vaultSessionCookie(request, token) },
  };
}

/**
 * The credential a request carries, and which transport carried it.
 *
 * The rules, in order:
 *
 * 1. A broker-mode server reads the header only. A cookie is never a
 *    credential there, so a page holding one cannot act as the native
 *    transport (the packaged desktop's promise is that the credential never
 *    crosses the network).
 * 2. A browser-mode server reads the cookie — every cookie of this name the jar
 *    presented, because a planted one can arrive first. A request that presents
 *    a cookie from a foreign origin is refused.
 * 3. The header stays accepted in browser mode for the clients that hold a
 *    token (the dev tooling, the e2e helpers), but only when the jar carried no
 *    cookie at all. It carries the same single live token, so accepting it
 *    widens nothing.
 */
export function resolveVaultCredential(
  request: Request,
  options: { broker: boolean },
): VaultCredentialResolution {
  const header = request.headers.get(VAULT_SESSION_HEADER_NAME);
  if (options.broker) {
    if (header === null || header === "") return { kind: "none" };
    return { kind: "credential", tokens: [header], carrier: "header" };
  }
  const cookies = readVaultSessionCookies(request);
  if (cookies.length === 0) {
    if (header === null || header === "") return { kind: "none" };
    // This branch does NOT ask the origin gate, deliberately. The clients that
    // hold this token and no cookie are the non-browser ones (curl, the e2e
    // helpers, the dev tooling) and they send no `Origin`; a page cannot reach
    // it either, because a cross-origin `x-vault-session` is not a simple
    // request and needs a preflight this server never answers. What it leaves
    // open is the local-SERVER replay the ADR records beside #343: a process on
    // this box sets any `Origin` it likes — and it needs the token first. Stated
    // in docs/adr/0013-shared-vault-session.md, in Consequences.
    return { kind: "credential", tokens: [header], carrier: "header" };
  }
  if (vaultOriginGate(request, options) === "foreign-origin") return { kind: "refused", reason: "foreign-origin" };
  return { kind: "credential", tokens: cookies, carrier: "cookie" };
}
