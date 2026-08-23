import path from "node:path";

export type AppConfig = {
  host: string;
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
  return {
    host: env.DOKAN_HOST ?? "127.0.0.1",
    port: env.DOKAN_PORT && Number(env.DOKAN_PORT) ? Number(env.DOKAN_PORT) : 4317,
    portExplicit: env.DOKAN_PORT !== undefined && env.DOKAN_PORT !== "" && Number(env.DOKAN_PORT) !== 0, 
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