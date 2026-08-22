import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // same-origin API: the webview never talks to the Bun api directly,
    // so auth cookies stay same-origin and no CORS config is needed
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  build: {
    outDir: "dist",
  },
});