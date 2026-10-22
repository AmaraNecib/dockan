/**
 * The hostname the app is served from (#343).
 *
 * The vault session cookie is host-scoped and cookies ignore ports, so an app
 * served from `127.0.0.1` hands that cookie to EVERY other local service on
 * the machine: each one receives it on its next request and can replay it
 * from its own process, where it picks its own `Origin` — and no origin check
 * can tell that replay from the app's own. `HttpOnly` does not help. It stops
 * JavaScript reading the cookie, not another server receiving it.
 *
 * The fix is a NAME this machine does not share with everything else. A
 * dedicated loopback hostname does that: `dokan.localhost` resolves to
 * 127.0.0.1 in every browser (RFC 6761 §6.3), while the cookie's host stays
 * `dokan.localhost` — so the services on `127.0.0.1` and on `localhost` never
 * receive it, and the app's own origin check still sees its own origin.
 *
 * ONE place names it. The api, the vite dev server, the e2e harness and the
 * desktop shell read the same value from the same environment variable, so a
 * machine that must keep `127.0.0.1` sets it once and every surface moves
 * together.
 */

/** The environment variable that names the app host. */
export const APP_HOST_ENV_VAR = "DOKAN_APP_HOST";

/** The default app host: a name only this app uses. */
export const DEFAULT_APP_HOST = "dokan.localhost";

/**
 * The part of the environment this module reads: the one variable, and
 * whatever else the caller's environment carries. An index signature rather
 * than a single named property, so a whole `process.env` fits without a cast.
 */
export type AppHostEnv = { readonly [key: string]: string | undefined };

/**
 * Resolve the app host from the environment.
 *
 * Blank means unset — the same convention the api uses for `DOKAN_HOST` and
 * `DOKAN_PORT`: `""` is a value someone typed, and an empty hostname is not a
 * name. A value that is not a bare hostname throws instead of being served:
 * `DOKAN_APP_HOST=http://dokan.localhost:5173` (a URL) or
 * `DOKAN_APP_HOST=dokan.localhost:5173` (a host and a port) are the two ways
 * this gets typed, and both would produce an origin no browser can resolve.
 */
export function resolveAppHost(env: AppHostEnv): string {
  const raw = env[APP_HOST_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_APP_HOST;
  const host = raw.trim().toLowerCase();
  if (!isHostname(host)) {
    throw new Error(
      `${APP_HOST_ENV_VAR} must be a bare hostname — letters, digits, dots and hyphens, ` +
        `without a scheme, a port or a path. Got ${JSON.stringify(raw)}.`,
    );
  }
  return host;
}

/** The origin the browser reaches the app at. */
export function appOriginFor(host: string, port: number | string): string {
  return `http://${host}:${port}`;
}

/**
 * True for the loopback addresses every service on the machine shares.
 *
 * `127.0.0.1` and `localhost` are one address under two names, and cookies
 * ignore ports — so a cookie written for either of them is handed to every
 * other local service (#343). A dedicated name such as `dokan.localhost` is
 * not shared, and neither is any other name that is not one of these.
 */
export function isSharedLoopbackAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * A hostname: dot-separated labels of letters, digits and hyphens, each label
 * starting and ending with a letter or a digit. An IP literal passes — it is
 * the escape hatch for a machine that cannot resolve a name — and a trailing
 * dot does not, because `dokan.localhost.` is a different cookie host from
 * `dokan.localhost`.
 */
function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  return host.split(".").every((part) => label.test(part));
}
