import path from "node:path";

import { isWildcardBindHost, probeHostFor } from "./lib/port-record";

export type AppConfig = {
  host: string;
  /** host that liveness probes CONNECT to (loopback for wildcard binds) */
  probeHost: string;
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
  return {
    host: requestedHost,
    probeHost: probeHostFor(requestedHost),
    port: portIsValid ? parsedPort : 4317,
    portExplicit: portIsValid, 
    dataDir,
    webDataDir,
    portRecordDir,
    bootToken,
    version: "0.1.0",
    db: {
      driver: requested,
      path: env.DOKAN_DB_PATH ?? path.join(dataDir, "dokan.db"),
    },
  };
}