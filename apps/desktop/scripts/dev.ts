#!/usr/bin/env bun
/**
 * `tauri dev`, with the app's own hostname carried into the webview.
 *
 * `tauri.conf.json` is static JSON, so its `devUrl` cannot read `DOKAN_APP_HOST`:
 * with a renamed host the api trusted `http://shop.localhost:5173` while the
 * desktop still opened `http://dokan.localhost:5173` (#357 review). Tauri takes a
 * config OVERLAY at dev time, so the resolved value is handed over here instead of
 * being frozen in the file — one place names the host, and every surface moves.
 *
 * `--no-dev-server-wait` stays: the Rust CLI cannot resolve `*.localhost` (RFC
 * 6761 is a browser rule; the OS resolver does not implement it) and panics in its
 * readiness wait. The webview is Chromium and resolves the name itself.
 */
import { resolveAppHost } from "../../../packages/contracts/src/app-host";

const host = resolveAppHost(process.env);
const port = process.env.DOKAN_WEB_PORT ?? "5173";
const overlay = JSON.stringify({ build: { devUrl: `http://${host}:${port}` } });

const child = Bun.spawn(["tauri", "dev", "--no-dev-server-wait", "--config", overlay], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, DOKAN_APP_HOST: host },
});
process.exit(await child.exited);
