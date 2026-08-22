import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

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
      "/api": { target: `http://127.0.0.1:${process.env.DOKAN_PORT ?? 4317}`, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
  },
});