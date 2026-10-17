import { expect, test } from "@playwright/test";
import { openSystemNav, signIn } from "./auth-helpers";

/**
 * The diagnostics viewer is admin-session-guarded, reachable
 * from the nav, and renders today's JSONL log tail (newest first). A raw
 * unauthenticated RPC call seeds a real RPC_ERROR row with a stable DKN code
 * so the code badge is proven end to end.
 */
test("diagnostics viewer: guarded, in nav, shows today's tail with DKN codes", async ({ page }) => {
  // 1. logged-out visitors see the auth gate, never the log
  await page.goto("/diagnostics");
  await expect(page.getByTestId("diagnostics-title")).toHaveCount(0);
  await expect(
    page
      .getByRole("heading", { name: "تسجيل الدخول" })
      .or(page.getByRole("heading", { name: "مرحباً بك في دكان" })),
  ).toBeVisible();

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

  // 3. sign in at /diagnostics: the post-login reload lands here, proving auth
  // AND that the route renders for a session
  await signIn(page, { startPath: "/diagnostics", landingTestId: "diagnostics-title" });
  await expect(page.getByTestId("diagnostics-title")).toContainText("سجل التشخيص");

  // 4. the page is registered in the nav (reachable from the home view)
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "الرئيسية" })).toBeVisible();
  await openSystemNav(page);
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

  // 6. the seeded RPC_ERROR row renders with its stable DKN badge. INVARIANT:
  // the tail is newest-first and nothing logs after the seed below, so .first()
  // is the seeded row; a future spec that logs RPC errors later must not rely
  // on the same assumption
  await expect(page.getByTestId("diagnostics-row").first()).toBeVisible();
  // #253 — the event badge renders Arabic; the raw code survives on data-event
  await expect(page.getByTestId("diagnostics-list")).toContainText("خطأ في طلب");
  await expect(page.getByTestId("diagnostics-event").first()).toHaveAttribute("data-event", "RPC_ERROR");
  const code = page.getByTestId("diagnostics-code").first();
  await expect(code).toHaveText(/^DKN-[0-9A-F]{8}$/);
});