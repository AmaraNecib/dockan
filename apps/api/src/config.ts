import path from "node:path";

export type AppConfig = {
  host: string;
  port: number;
  /** root folder holding the SQLite data file, the backups/ and logs/ folders */
  dataDir: string;
  /** MVP password-reset secret (per docs/adr + last grilling round). Env-overridable. */
  buildSecret: string;
  version: string;
};

export function createAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.DOKAN_DATA_DIR ?? path.join(process.cwd(), "data");
  return {
    host: env.DOKAN_HOST ?? "127.0.0.1",
    port: Number(env.DOKAN_PORT ?? 4317),
    dataDir,
    buildSecret: env.DOKAN_BUILD_SECRET ?? "dokan-dev-secret",
    version: "0.1.0",
  };
}