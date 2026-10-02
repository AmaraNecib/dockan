import { Hono } from "hono";

import type { AppConfig } from "../config";
import { tokenMatches } from "./boot-token";
import { UnsupportedSchemaVersionError } from "./schema-version";

/**
 * The standalone page an older build serves when it opens a database stamped
 * by a newer one (ADR-0008 §4.5). The store, auth and router never start, so
 * nothing touches the newer file; the desktop shell still verifies the port
 * (this server echoes the boot token and publishes the port record) and
 * navigates to this page, so the owner sees the Arabic "update the app"
 * message instead of a generic startup failure.
 */
/**
 * The standalone page's copy. This page is served before the web bundle (or
 * any API route) exists, so it has no i18n runtime and its Arabic is
 * deliberately embedded here; every in-app string lives in
 * apps/web/src/lib/i18n.ts (locale-neutral guard allow-lists these lines).
 */
const SCHEMA_REFUSAL_PAGE_COPY = {
  title: "دكان — تحديث مطلوب",
  heading: "تحديث مطلوب",
  hint: "بياناتك سليمة ولم تُمسّ. ثبّت إصداراً أحدث من دكان ثم أعد فتح التطبيق.",
  messageTemplate: "تعذّر فتح البيانات: هذه النسخة من التطبيق أقدم من قاعدة البيانات (نسخة قاعدة البيانات {found}، والمدعومة {supported}). حدّث دكان ثم أعد المحاولة.",
} as const;

function refusalMessage(foundVersion: number, supportedVersion: number): string {
  return SCHEMA_REFUSAL_PAGE_COPY.messageTemplate
    .replace("{found}", String(foundVersion))
    .replace("{supported}", String(supportedVersion));
}

export function refusalPageHtml(foundVersion: number, supportedVersion: number): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${SCHEMA_REFUSAL_PAGE_COPY.title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafafa; color: #111; font-family: system-ui, sans-serif; }
      main { max-width: 32rem; margin: 1rem; padding: 2rem; background: #fff; border: 1px solid #e5e5e5; border-radius: 1rem; text-align: center; box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
      h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
      p { line-height: 1.8; margin: 0.5rem 0; }
      .hint { color: #666; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${SCHEMA_REFUSAL_PAGE_COPY.heading}</h1>
      <p>${refusalMessage(foundVersion, supportedVersion)}</p>
      <p class="hint">${SCHEMA_REFUSAL_PAGE_COPY.hint}</p>
    </main>
  </body>
</html>
`;
}

/**
 * Run one boot step and route an unsupported-schema error to the refusal
 * path. The error can come from the open gate OR from the write-locked stamp
 * in `store.setup()` (a newer sidecar stamped the shared file between our
 * open and our stamp); both must land on the same standalone Arabic page
 * instead of crashing the sidecar into the shell's generic failure UI.
 */
export async function guardBootStep<T>(
  step: () => T | Promise<T>,
  refuse: (error: UnsupportedSchemaVersionError) => Promise<never>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError) {
      await refuse(error);
    }
    throw error;
  }
}

/**
 * The minimal refusal app. `/health-token` keeps the shell's identity probe
 * working (the token echo is the same contract the normal boot serves), and
 * everything else answers the update page — never the API. `/health` answers
 * 503 as well: a status-only readiness check must see the refusal, not a
 * healthy API whose body says otherwise.
 */
export function createSchemaRefusalApp(config: AppConfig, error: UnsupportedSchemaVersionError): Hono {
  const app = new Hono();
  app.get("/health-token", (c) => {
    if (config.bootToken !== undefined && tokenMatches(c.req.query("token"), config.bootToken)) {
      return c.json({ ok: true, token: config.bootToken });
    }
    return c.text("not found", 404);
  });
  app.get("/health", (c) =>
    c.json(
      {
        ok: false,
        error: "SCHEMA_VERSION_TOO_NEW",
        foundVersion: error.foundVersion,
        supportedVersion: error.supportedVersion,
      },
      503,
    ),
  );
  app.all("*", (c) => c.html(refusalPageHtml(error.foundVersion, error.supportedVersion), 503));
  return app;
}
