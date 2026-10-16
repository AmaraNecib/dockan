import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import { createSchemaRefusalApp, guardBootStep, refusalPageHtml } from "./schema-refusal";
import { CURRENT_SCHEMA_VERSION, UnsupportedSchemaVersionError } from "./schema-version";

/**
 * ADR-0008 §4.5: a database written by a newer app must refuse the old build
 * with a clear Arabic message. The desktop shell still verifies the port and
 * navigates to this standalone page, so the owner sees the message instead of
 * a generic startup failure.
 */
const TOKEN = "b".repeat(64);

describe("refusalPageHtml", () => {
  it("carries the Arabic update message with both versions", () => {
    const html = refusalPageHtml(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION);
    expect(html).toContain("تحديث مطلوب");
    expect(html).toContain("أقدم من قاعدة البيانات");
    expect(html).toContain(String(CURRENT_SCHEMA_VERSION + 1));
    expect(html).toContain(String(CURRENT_SCHEMA_VERSION));
    expect(html).toContain('dir="rtl"');
  });
});

describe("createSchemaRefusalApp", () => {
  const error = new UnsupportedSchemaVersionError(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION);

  it("echoes the boot token so the shell can verify the port and navigate", async () => {
    const app = createSchemaRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: TOKEN }), error);

    const ok = await app.fetch(new Request(`http://localhost/health-token?token=${TOKEN}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, token: TOKEN });

    const wrong = await app.fetch(new Request("http://localhost/health-token?token=wrong"));
    expect(wrong.status).toBe(404);
  });

  it("serves the update page for the UI and every API path", async () => {
    const app = createSchemaRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: TOKEN }), error);

    const page = await app.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("أقدم من قاعدة البيانات");

    // no store/auth/router started: API paths answer the page, never an API
    const api = await app.fetch(new Request("http://localhost/api/rpc/health"));
    expect(api.status).toBe(503);
    expect(await api.text()).toContain("تحديث مطلوب");
  });

  it("answers health with 503 and the honest version mismatch", async () => {
    const app = createSchemaRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: TOKEN }), error);
    const res = await app.fetch(new Request("http://localhost/health"));
    // status-only readiness checks must see the refusal, not a healthy API
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "SCHEMA_VERSION_TOO_NEW",
      foundVersion: CURRENT_SCHEMA_VERSION + 1,
      supportedVersion: CURRENT_SCHEMA_VERSION,
    });
  });

  it("refuses /health-token when the build has no boot token", async () => {
    const app = createSchemaRefusalApp(createAppConfig({}), error);
    const res = await app.fetch(new Request("http://localhost/health-token?token=anything"));
    expect(res.status).toBe(404);
  });
});

describe("guardBootStep", () => {
  it("routes an unsupported-schema error to the refusal path", async () => {
    const error = new UnsupportedSchemaVersionError(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION);
    const seen: UnsupportedSchemaVersionError[] = [];

    await expect(
      guardBootStep(
        () => {
          throw error;
        },
        async (caught) => {
          seen.push(caught);
          throw caught;
        },
      ),
    ).rejects.toBe(error);
    expect(seen).toEqual([error]);
  });

  it("rethrows any other error untouched", async () => {
    const boom = new Error("boom");
    let refused = 0;

    await expect(
      guardBootStep(
        () => {
          throw boom;
        },
        async () => {
          refused += 1;
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(refused).toBe(0);
  });

  it("returns a successful step's value", async () => {
    await expect(
      guardBootStep(
        () => 42,
        async () => {
          throw new Error("unreachable");
        },
      ),
    ).resolves.toBe(42);
  });
});

describe("a database advanced between open and setup", () => {
  itHeavy("lands on the refusal page instead of a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-refusal-boot-"));
    try {
      const dbPath = path.join(dir, "test.db");
      const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath, DOKAN_BOOT_TOKEN: TOKEN });
      // the open gate passes at version 0...
      const conn = openConnection(config);
      try {
        // ...then a newer sidecar stamps the shared file while this boot sits
        // between its open and the write-locked stamp inside setup()
        const newer = new Database(dbPath);
        newer.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
        newer.close();

        const store = createDrizzleStore(conn);
        const seen: UnsupportedSchemaVersionError[] = [];
        await expect(
          guardBootStep(
            () => store.setup(),
            async (error) => {
              seen.push(error);
              // main.ts serves the refusal page here and never returns
              throw error;
            },
          ),
        ).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.foundVersion).toBe(CURRENT_SCHEMA_VERSION + 1);

        // the exact page main.ts serves for this error
        const app = createSchemaRefusalApp(config, seen[0]!);
        const page = await app.fetch(new Request("http://localhost/"));
        expect(page.status).toBe(503);
        expect(await page.text()).toContain("أقدم من قاعدة البيانات");
      } finally {
        conn.close();
      }
    } finally {
      // Windows keeps the sqlite/WAL handles briefly after close
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
  });
});
