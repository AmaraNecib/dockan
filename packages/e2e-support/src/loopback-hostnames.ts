/**
 * Node's resolver and a browser's do not agree about `*.localhost` (#343).
 *
 * RFC 6761 §6.3 says a resolver must answer every `*.localhost` name with the
 * loopback address, and Chromium does — which is why the dev browser and the
 * desktop WebView2 reach `dokan.localhost`. The OS resolver on this machine
 * does not: `dns.lookup("dokan.localhost")` fails with ENOTFOUND, and so do
 * Node's own `fetch` and Playwright's request client.
 *
 * The harness runs on Node, so it needs the mapping the browser already has.
 * Installing it here is what lets a spec talk to the app's own name — which
 * is the whole point of the name: the vault cookie is scoped to it, so a
 * request that must carry the cookie has to be addressed to it.
 */

import dns from "node:dns";

/** The address a `*.localhost` name resolves to. */
const LOOPBACK = "127.0.0.1";

/**
 * Whether a hostname is one the loopback rule covers: `localhost` itself and
 * every name under it. A name that merely ENDS in ".localhost" text is not
 * one — `notlocalhost` is a real domain and must resolve as before.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** The address a lookup answers with: one address, or the whole set. */
export type LookupResult = string | dns.LookupAddress[];

/** What the promise form of the resolver answers with. */
type PromiseLookupResult = dns.LookupAddress | dns.LookupAddress[];

/** The callback shape both forms of the resolver take. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: LookupResult,
  family?: number,
) => void;

/**
 * Make `*.localhost` resolve to the loopback address in this process.
 *
 * Called once, by the Playwright config, before any spec runs. Everything
 * else keeps resolving exactly as before: the patch is a lookup, not a
 * policy, and a name that is not a loopback name is passed straight through.
 */
export function installLoopbackHostnames(): void {
  const original = dns.lookup;
  const originalPromise = dns.promises.lookup;

  const patched = (
    hostname: string,
    options?: dns.LookupOptions | LookupCallback,
    callback?: LookupCallback,
  ): void | Promise<PromiseLookupResult> => {
    const host = isLoopbackHostname(hostname) ? LOOPBACK : hostname;
    if (options === undefined) return originalPromise(host);
    // the resolver's two shapes: `lookup(host, callback)` and
    // `lookup(host, options, callback)`. A callback is a function; options are
    // a plain object.
    if (options instanceof Function) {
      original(host, options);
      return undefined;
    }
    if (callback === undefined) return originalPromise(host, options);
    original(host, options, callback);
    return undefined;
  };

  // SAFETY: the patch forwards every call to the original resolver with the
  // same arguments and only rewrites the hostname, so it satisfies
  // dns.lookup's overloads — the callback form and the promise form the
  // original offers. The cast records that equivalence and changes nothing
  // at runtime.
  dns.lookup = patched as typeof dns.lookup;

  const patchedPromise = (hostname: string, options?: dns.LookupOptions): Promise<PromiseLookupResult> =>
    options === undefined
      ? originalPromise(isLoopbackHostname(hostname) ? LOOPBACK : hostname)
      : originalPromise(isLoopbackHostname(hostname) ? LOOPBACK : hostname, options);

  // SAFETY: same equivalence as above, for the promise form of the resolver:
  // one hostname rewritten, every argument passed through untouched.
  dns.promises.lookup = patchedPromise as typeof dns.promises.lookup;
}
