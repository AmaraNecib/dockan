import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";


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

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    host: "127.0.0.1",
    port: Number(process.env.DOKAN_WEB_PORT ?? 5173),
    // A trusted origin names ONE port (#347): better-auth accepts cookie-bearing
    // writes only from it, so a silent fallback to 5174 would let a developer sign
    // in and not out. Fail loudly instead — an occupied port is a thing to fix,
    // not a thing to move around.
    strictPort: true,
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