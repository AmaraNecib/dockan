/**
 * What a request to a refused start means (#277).
 *
 * Serving the refusal and asking the folder again are two different things, and
 * collapsing them broke the bounded backoff (greptile P2 on #298): every
 * request ran a reclaim attempt, the attempt cancelled the armed tick and
 * re-armed it at the fifteen-second cap, so a client polling faster than the
 * cap kept the automatic tick from ever firing. The retry rate became the
 * client's rate, and "retries with bounded backoff while it serves the
 * refusal" only held while nobody asked.
 *
 * So the owner's retry gets its own route and everything else is served as-is.
 * The route is a POST because it does work on the folder: a GET is a prefetch,
 * a link or a cached read, and none of those may take the lock.
 */

/** The one route that asks the folder again. */
export const RECLAIM_RETRY_PATH = "/api/vault/reclaim";

/**
 * True only for the explicit retry the refusal screen posts. `url` may be
 * absolute (a server-received Request) or a bare path.
 */
export function isReclaimRetry(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  // the pathname alone decides: a query string cannot smuggle a retry past
  // the route, and a proxy's absolute URL is normalised to the same path
  return new URL(url, "http://localhost").pathname === RECLAIM_RETRY_PATH;
}
