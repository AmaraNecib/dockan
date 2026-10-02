import { describe, expect, it } from "bun:test";

import { createAppConfig } from "../config";
import { createSchemaRefusalApp, refusalPageHtml } from "./schema-refusal";
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

  it("answers health with the honest version mismatch", async () => {
    const app = createSchemaRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: TOKEN }), error);
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
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
