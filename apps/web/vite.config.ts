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
  if (process.env.DOKAN_PORT !== undefined) return Number(process.env.DOKAN_PORT);
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
  server: {
    // changeable: if the dev port is taken, vite picks another instead of
    // crashing (the user is an accountant, not a developer)
    host: "127.0.0.1",
    port: Number(process.env.DOKAN_WEB_PORT ?? 5173),
    strictPort: false,
    // same-origin API: the webview never talks to the Bun api directly,
    // so auth cookies stay same-origin and no CORS config is needed
    proxy: {
      // SAFETY: this entry's router field re-resolves the destination per
      // request (the api's actual port), and the object cast at its end only
      // widens to vite's ProxyOptions type
      "/api": {
        target: `http://127.0.0.1:${apiTargetPort()}`, // SAFETY: router overrides it per request
        changeOrigin: true,
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