import path from "node:path";

import { appOriginFor, resolveAppHost } from "@dokan/contracts";

import { isWildcardBindHost, probeHostFor } from "./lib/port-record";

export type AppConfig = {
  host: string;
  /** host that liveness probes CONNECT to (loopback for wildcard binds) */
  probeHost: string;
  /**
   * The hostname the app is REACHED at — not where the api binds (`host`,
   * which stays 127.0.0.1 so nothing but this machine can reach it).
   *
   * The vault session cookie is host-scoped and cookies ignore ports, so an
   * app served from `127.0.0.1` hands that cookie to every other local
   * service on the machine, which can then replay it from its own process
   * (#343). The dev server and the e2e therefore serve the app under a name
   * of its own (`dokan.localhost`), and the cookie stays scoped to it.
   */
  appHost: string;
  /**
   * The origin the browser reaches the app at, when a web server sits in front
   * of the api (dev, e2e): `http://<appHost>:<DOKAN_WEB_PORT>`. Undefined when
   * no web server is in front — a packaged build, where the api serves the ui
   * itself and the browser's origin IS the api's own.
   */
  appOrigin: string | undefined;
  port: number;
  /** true when DOKAN_PORT was set explicitly: that port is authoritative, so
   * the api must NOT silently fall back to another one (greptile P1) */
  portExplicit: boolean;
  /** root folder holding the SQLite data file, the backups/ and logs/ folders */
  dataDir: string;
  /** absolute path of the built web UI to serve statically. Set only by the
   * desktop bootstrap (packaged builds): the desktop webview loads the api's
   * origin, so the api also serves the UI. Absent in dev/e2e — the vite dev
   * server and its proxy own the frontend there, unchanged. */
  webDataDir: string | undefined;
  /** directory holding the port-record files (.dokan-port, .dokan-port.lock,
   * .dokan-port.registry). Set by the desktop bootstrap to the OS app-data
   * dir. Absent in dev/e2e: the record lives at the git workspace root, which
   * the vite proxy walks up to find. */
  portRecordDir: string | undefined;
  /** one-time per-boot identity handed to the sidecar by the desktop shell
   * (PR #51 finding 1). When set, the api serves `GET /health-token` which
   * only answers with the matching token — the shell verifies the server on
   * its chosen port is really its own child before navigating to it, so a
   * stale or modified port record can never redirect the webview. Absent in
   * dev/e2e: no token endpoint exists there. */
  bootToken: string | undefined;
  version: string;
  /**
   * Unified vault (ADR-0008 §4.6). "on" (default) requires the encrypted
   * store: no database is opened and no app route is served until the vault
   * is unlocked. "disabled" keeps the legacy plaintext path and exists only
   * for development and the e2e suite; a packaged build (DOKAN_WEB_DIST set)
   * always forces "on", so an inherited environment value cannot disable the
   * gate on a shop install.
   */
  vault: "on" | "disabled";
  /** true when a packaged build ignored an inherited DOKAN_VAULT=disabled */
  vaultOptOutIgnored: boolean;
  /**
   * Desktop-shell stdin broker (issue #141): DOKAN_VAULT_STDIN=1 puts the
   * pre-boot gate on the shell's pipe. The HTTP credential routes are then
   * refused, so the passphrase can only arrive over stdin and never crosses
   * the network stack. Only meaningful while the vault is on.
   */
  vaultBroker: boolean;
  /** persistence driver selection — the store port stays fixed (ADR-0003) */
  db: {
    driver: "sqlite" | "postgres";
    /** database file path (sqlite) */
    path: string;
  };
};

/** Drivers the store can be built on today. Postgres joins when its adapter
 * lands (ADR-0003); until then, requesting it fails here, at config time. */
const SUPPORTED_DRIVERS = ["sqlite"] as const;
const isDriver = (v: string): v is (typeof SUPPORTED_DRIVERS)[number] =>
  // SAFETY: the includes() membership check against SUPPORTED_DRIVERS below is the invariant
  SUPPORTED_DRIVERS.includes(v as (typeof SUPPORTED_DRIVERS)[number]);

export function createAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.DOKAN_DATA_DIR ?? path.join(process.cwd(), "data");
  const webDataDir = env.DOKAN_WEB_DIST === undefined || env.DOKAN_WEB_DIST === "" ? undefined : path.resolve(env.DOKAN_WEB_DIST);
  const portRecordDir =
    env.DOKAN_PORT_ROOT === undefined || env.DOKAN_PORT_ROOT === "" ? undefined : path.resolve(env.DOKAN_PORT_ROOT);
  const bootToken = env.DOKAN_BOOT_TOKEN === undefined || env.DOKAN_BOOT_TOKEN === "" ? undefined : env.DOKAN_BOOT_TOKEN;
  // Vault opt-out is explicit and dev/e2e-only: anything other than the exact
  // string "disabled" keeps encryption on, so a mistyped or inherited value
  // fails safe (encrypted). A packaged build (webDataDir set by the desktop
  // shell) refuses the opt-out entirely: the launcher environment must never
  // be able to skip the gate on a shop install.
  const packagedBuild = webDataDir !== undefined;
  const requestedVaultDisabled = env.DOKAN_VAULT === "disabled";
  const vaultOptOutIgnored = requestedVaultDisabled && packagedBuild;
  const vault: "on" | "disabled" = requestedVaultDisabled && !packagedBuild ? "disabled" : "on";
  // the broker exists only for the pre-boot gate; a plaintext dev/e2e run must
  // keep the HTTP gate even if DOKAN_VAULT_STDIN leaked into its environment
  const vaultBroker = vault === "on" && env.DOKAN_VAULT_STDIN === "1";
  const requested = env.DOKAN_DB_DRIVER ?? "sqlite";
  if (!isDriver(requested)) {
    throw new Error(
      `DOKAN_DB_DRIVER must be one of: ${SUPPORTED_DRIVERS.join(", ")}. Got "${requested}". ` +
        "The postgres adapter is not implemented yet (ADR-0003); it arrives behind the same switch.",
    );
  }
  // issue #52: a wildcard bind exposes the api on every interface (LAN,
  // hotspot, ...). Loopback stays the default; going wide requires a second,
  // explicit opt-in naming the same interface, so a stray DOKAN_HOST=0.0.0.0
  // copied from some tutorial fails loudly at boot instead of silently
  // publishing the store to the room.
  // Blank means unset — same convention as DOKAN_PORT — because "" itself
  // binds every interface on some runtimes.
  const hostEnv = env.DOKAN_HOST ?? "";
  const requestedHost = hostEnv.trim() === "" ? "127.0.0.1" : hostEnv;
  if (isWildcardBindHost(requestedHost) && env.DOKAN_HOST_INTERFACE !== requestedHost) {
    throw new Error(
      `DOKAN_HOST=${requestedHost} binds every network interface and is refused by default. ` +
        `To opt in deliberately, also set DOKAN_HOST_INTERFACE=${requestedHost}; ` +
        `otherwise remove DOKAN_HOST to keep the loopback-only default (127.0.0.1).`,
    );
  }
  // one shared predicate with the vite proxy: only a finite positive port
  // counts as explicit; "" / "abc" / "0" / "-5" all mean "unset" on both sides
  const portEnv = env.DOKAN_PORT ?? "";
  const parsedPort = portEnv === "" ? NaN : Number(portEnv);
  const portIsValid = Number.isFinite(parsedPort) && parsedPort > 0;
  const appHost = resolveAppHost(env);
  return {
    host: requestedHost,
    probeHost: probeHostFor(requestedHost),
    appHost,
    appOrigin: webOrigin(env, appHost),
    port: portIsValid ? parsedPort : 4317,
    portExplicit: portIsValid, 
    dataDir,
    webDataDir,
    portRecordDir,
    bootToken,
    vault,
    vaultOptOutIgnored,
    vaultBroker,
    version: "0.1.0",
    db: {
      driver: requested,
      path: env.DOKAN_DB_PATH ?? path.join(dataDir, "dokan.db"),
    },
  };
}

/**
 * The origin the browser reaches the app at, when a web server sits in front
 * of the api.
 *
 * `DOKAN_WEB_PORT` is the vite dev server's own variable — the same one the
 * dev server reads — so the two cannot disagree about which origin the app
 * answers on. Blank or nonsense means "no web server in front" (a packaged
 * build), not a guess: there the api serves the ui itself and the browser's
 * origin IS the api's own.
 */
function webOrigin(env: NodeJS.ProcessEnv, appHost: string): string | undefined {
  const raw = env.DOKAN_WEB_PORT ?? "";
  if (raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return appOriginFor(appHost, port);
}