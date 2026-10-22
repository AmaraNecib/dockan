import fs from "node:fs";
import path from "node:path";

import { resolveAppHost } from "../../packages/contracts/src/app-host";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The hostname the app is SERVED FROM (#343) — the name in the browser's
 * address bar, not the address the server binds.
 *
 * The vault session cookie is host-scoped and cookies ignore ports, so an app
 * served from `127.0.0.1` hands that cookie to every other local service on
 * this machine, which can then replay it from its own process. Serving the
 * app under a name of its own keeps the cookie scoped to this app: the
 * services on `127.0.0.1` and on `localhost` never receive it.
 *
 * The BIND address stays 127.0.0.1 — the server listens on the loopback
 * interface either way, and `dokan.localhost` resolves to it in the browser
 * (RFC 6761). One place names the host (packages/contracts/src/app-host.ts);
 * `DOKAN_APP_HOST` moves every surface at once, and a machine that must keep
 * `127.0.0.1` sets it there.
 *
 * Imported by path, not as "@dokan/contracts": this file is loaded by Node,
 * which follows the workspace package's extensionless imports and fails on
 * them. The module itself has no imports, so the bundler inlines it.
 */
const APP_HOST = resolveAppHost(process.env);

/**
 * The api probes to a free port when the default is busy; the proxy must
 * follow it. DOKAN_PORT wins, then the port file the api writes at boot,
 * then the default.
 */
function apiTargetPort(): number {
  // an explicit DOKAN_PORT is authoritative: it overrides any recorded port
  // from an earlier API process (greptile P1 follow-up). Only when unset does
  // the recorded actual port (written at bind time) count; 4317 is the default.
  const explicit = process.env.DOKAN_PORT;
  if (explicit !== undefined && explicit !== "") {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  let dir = process.cwd();
  for (;;) {
    const file = path.join(dir, ".dokan-port");
    if (fs.existsSync(file)) {
      const parsed = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 4317;
}

/**
 * The port a resolved server URL carries.
 *
 * A URL without a port is the protocol's default (80 for http), which is what
 * the server would be listening on.
 */
function portOf(url: string): number {
  const parsed = new URL(url);
  return parsed.port === "" ? 80 : Number(parsed.port);
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // The owner opens the app by hand, and vite prints only its BIND
      // address — `127.0.0.1`, the address every local service shares. Open
      // there and the vault cookie lands on the shared host (the very defect
      // #343 closes). Print the name to open, with the port the server
      // actually took.
      name: "dokan-print-app-url",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          // vite resolves its own URLs in a listener it PREPENDS to this
          // event, so by the time this runs the URL — and the port the
          // server really took — is known.
          const url = server.resolvedUrls?.local[0];
          const port = url === undefined ? server.config.server.port : portOf(url);
          server.config.logger.info(
            `\n  Dokan: http://${APP_HOST}:${port}\n  Open that name, not 127.0.0.1 — the vault cookie is scoped to it.\n`,
          );
        });
      },
    },
  ],
  resolve: {
    alias: {
      // shadcn/ui components import via the @ alias; keep in sync with tsconfig paths
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // changeable: if the dev port is taken, vite picks another instead of
    // crashing (the user is an accountant, not a developer) — but only when no
    // port was asked for. An explicit DOKAN_WEB_PORT (e2e, scripts) stays strict
    // so the waiting client is not left pointing at a port nobody listens on.
    //
    // The bind address is the loopback interface and stays that way; the NAME
    // the app answers on is APP_HOST above (#343).
    host: "127.0.0.1",
    port: Number(process.env.DOKAN_WEB_PORT ?? 5173),
    // A trusted origin names ONE port (#347): better-auth accepts cookie-bearing
    // writes only from it, so a silent fallback to 5174 would let a developer sign
    // in and not out. Fail loudly instead — an occupied port is a thing to fix,
    // not a thing to move around. #343 keeps this: the app's own name is one
    // origin too, and it is derived from that same port.
    strictPort: true,
    // vite refuses a host it does not know by default, which would 403 the
    // app's own name. `*.localhost` is allowed out of the box; naming the app
    // host explicitly also covers a deployment that renamed it.
    allowedHosts: [APP_HOST],
    // same-origin API: the webview never talks to the Bun api directly,
    // so auth cookies stay same-origin and no CORS config is needed
    proxy: {
      // SAFETY: this entry's router field re-resolves the destination per
      // request (the api's actual port), and the object cast at its end only
      // widens to vite's ProxyOptions type
      "/api": {
        target: `http://127.0.0.1:${apiTargetPort()}`, // SAFETY: router overrides it per request
        // The API's origin gate compares a request's `Origin` with the host the
        // request was addressed to (#319), so the proxy must forward the
        // browser's own `Host` instead of rewriting it to the api's port. With
        // `changeOrigin: true` a page on :5173 looked like a foreign origin to
        // a request the api then saw as `127.0.0.1:4317`, and every browser
        // write was refused. http-proxy's default is to pass the header
        // through, which is what the gate needs.
        changeOrigin: false,
        // http-proxy re-resolves the destination on every request, so the proxy
        // follows the api's actual port even when vite booted before the api
        // selected and recorded its fallback port (greptile P1)
        router: () => `http://127.0.0.1:${apiTargetPort()}`,
        // SAFETY: vite ProxyOptions are http-proxy options plus extras; the
        // router field is one of them, so the object below is assignable
      } as import("vite").ProxyOptions,
    },
  },
  build: {
    outDir: "dist",
  },
});