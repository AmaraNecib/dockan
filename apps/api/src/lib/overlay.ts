import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import type { AppConfig } from "../config";
import { tokenMatches } from "./boot-token";

/**
 * The live request handler. The second argument is the Node server env
 * (`@hono/node-server`'s HttpBindings), which carries the peer socket; the
 * vault gate's loopback guard reads it, so it must survive every hop.
 */
export type NodeRequestEnv = {
  incoming?: { socket?: { remoteAddress?: string } };
};

export type RequestHandler = (request: Request, env?: NodeRequestEnv) => Response | Promise<Response>;

export type OverlayDeps = {
  config: AppConfig;
  /** the app handler; absent until the vault is open (or on the legacy path) */
  api: RequestHandler | undefined;
  lockedApiHandler: RequestHandler;
  vaultApp: Hono | undefined;
  vaultState: () => string;
  webIndex: string | undefined;
};

/**
 * Compose the live request handler. The vault gate and the health endpoints
 * are always mounted; the app handler is present only after unlock. In
 * packaged builds the remaining paths serve the bundled UI (static files plus
 * an SPA fallback for client-routed paths). Dev/e2e never set DOKAN_WEB_DIST —
 * the vite dev server owns the frontend there.
 *
 * The vault gate is called with the overlay's env so `c.env.incoming` carries
 * the real peer address; forwarding only the raw Request made the loopback
 * credential guard see no peer and trust remote LAN clients (round-8 finding 1).
 */
export function createOverlay(deps: OverlayDeps): RequestHandler {
  const overlay = new Hono<{ Bindings: NodeRequestEnv }>();
  overlay.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    // PR #51 finding 1: the shell verifies the server on its chosen port is
    // really its own child by asking for the one-time token it handed over
    // via DOKAN_BOOT_TOKEN and checking the echo. Only the spawned api knows
    // the token, so a stale or modified port record pointing at an unrelated
    // localhost server (or a decoy that 200s everything) cannot satisfy this
    // endpoint. The token is never logged or rendered into the UI.
    if (pathname === "/health-token" && deps.config.bootToken !== undefined) {
      if (tokenMatches(url.searchParams.get("token"), deps.config.bootToken)) {
        return c.json({ ok: true, token: deps.config.bootToken });
      }
      return c.text("not found", 404);
    }
    if (deps.vaultApp !== undefined && pathname.startsWith("/api/vault/")) return deps.vaultApp.fetch(c.req.raw, c.env);
    if (pathname === "/health") {
      if (deps.api !== undefined) return deps.api(c.req.raw);
      return c.json({ ok: true, version: deps.config.version, vault: deps.vaultState() });
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (deps.api !== undefined) return deps.api(c.req.raw);
      return deps.lockedApiHandler(c.req.raw);
    }
    return next();
  });
  const index = deps.webIndex;
  if (deps.config.webDataDir !== undefined && index !== undefined) {
    const webRoot = deps.config.webDataDir;
    overlay.use("*", serveStatic({ root: webRoot }));
    overlay.use("*", async (c) => c.html(index));
  }
  return (req, env) => overlay.fetch(req, env);
}
