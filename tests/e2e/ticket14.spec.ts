import { expect, test } from "@playwright/test";

/**
 * Ticket 14 e2e: the diagnostics viewer is admin-session-guarded, reachable
 * from the nav, and renders today's JSONL log tail (newest first). A raw
 * unauthenticated RPC call seeds a real RPC_ERROR row with a stable DKN code
 * so the code badge is proven end to end.
 */
test("diagnostics viewer: guarded, in nav, shows today's tail with DKN codes", async ({ page }) => {
  // 1. logged-out visitors see the login screen, never the log
  await page.goto("/diagnostics");
  await expect(page.getByTestId("login-submit")).toBeVisible();
  await expect(page.getByTestId("diagnostics-title")).toHaveCount(0);

  // 2. seed a REAL server error before login: a raw unauthenticated RPC call
  // to the runnable endpoint fails auth/validation server-side and lands as
  // an RPC_ERROR row with a stable DKN code (verified against the live api)
  const seeded = await page.evaluate(async () => {
    const res = await fetch("/api/rpc/diagnosticsLogsTail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return res.status;
  });
  expect(seeded).toBeGreaterThanOrEqual(400);

  // 3. first-time setup + login (shared e2e flow); the login screen was at
  // /diagnostics, so the post-login reload lands here — proving auth AND that
  // the route renders for a session
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("diagnostics-title")).toContainText("سجل التشخيص");

  // 4. the page is registered in the nav (reachable from the home view)
  await page.goto("/");
  await expect(page.getByText("الرئيسية")).toBeVisible();
  await page.getByRole("link", { name: "التشخيص" }).click();
  await expect(page.getByTestId("diagnostics-title")).toContainText("سجل التشخيص");

  // 5. the viewer points at today's Algeria-local log file
  const today = new Date().toLocaleString("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  await expect(page.getByTestId("diagnostics-file")).toContainText(`${today}.jsonl`);

  // 6. the seeded RPC_ERROR row renders with its stable DKN badge
  await expect(page.getByTestId("diagnostics-row").first()).toBeVisible();
  await expect(page.getByTestId("diagnostics-list")).toContainText("RPC_ERROR");
  const code = page.getByTestId("diagnostics-code").first();
  await expect(code).toHaveText(/^DKN-[0-9A-F]{8}$/);
});