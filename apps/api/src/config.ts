import path from "node:path";

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
  /** MVP password-reset secret. Optional at boot: the reset procedure refuses
   * to run when absent, so the documented api startup paths never crash. */
  buildSecret: string | undefined;
  /** better-auth signing secret; a shared laptop is the threat model, so a static local default is fine */
  authSecret: string;
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
  const requested = env.DOKAN_DB_DRIVER ?? "sqlite";
  if (!isDriver(requested)) {
    throw new Error(
      `DOKAN_DB_DRIVER must be one of: ${SUPPORTED_DRIVERS.join(", ")}. Got "${requested}". ` +
        "The postgres adapter is not implemented yet (ADR-0003); it arrives behind the same switch.",
    );
  }
  // one shared predicate with the vite proxy: only a finite positive port
  // counts as explicit; "" / "abc" / "0" / "-5" all mean "unset" on both sides
  const portEnv = env.DOKAN_PORT ?? "";
  const parsedPort = portEnv === "" ? NaN : Number(portEnv);
  const portIsValid = Number.isFinite(parsedPort) && parsedPort > 0;
  return {
    host: env.DOKAN_HOST ?? "127.0.0.1",
    probeHost: env.DOKAN_HOST === "0.0.0.0" || env.DOKAN_HOST === "::" ? "127.0.0.1" : (env.DOKAN_HOST ?? "127.0.0.1"),
    port: portIsValid ? parsedPort : 4317,
    portExplicit: portIsValid, 
    dataDir,
    buildSecret: env.DOKAN_BUILD_SECRET,
    authSecret: env.DOKAN_AUTH_SECRET ?? "dokan-dev-auth-secret",
    version: "0.1.0",
    db: {
      driver: requested,
      path: env.DOKAN_DB_PATH ?? path.join(dataDir, "dokan.db"),
    },
  };
}