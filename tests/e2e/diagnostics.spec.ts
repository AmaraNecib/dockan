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

  // 6. the seeded RPC_ERROR row renders with its stable DKN badge. Setup may
  // append FIRST_TIME_SETUP after the unauthenticated probe, so locate the
  // seeded row by its raw event instead of assuming it remains newest.
  await expect(page.getByTestId("diagnostics-row").first()).toBeVisible();
  // #253 — the event badge renders Arabic; the raw code survives on data-event
  await expect(page.getByTestId("diagnostics-list")).toContainText("خطأ في طلب");
  const event = page.locator('[data-testid="diagnostics-event"][data-event="RPC_ERROR"]').first();
  await expect(event).toBeVisible();
  const code = event.locator("xpath=../..").getByTestId("diagnostics-code");
  await expect(code).toHaveText(/^DKN-[0-9A-F]{8}$/);
});

test("diagnostics keeps synthetic multiline stacks local without widening nearby content", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  const newestStack = Array.from(
    { length: 48 },
    (_, index) => `    at syntheticDiagnosticProbe${index} (C:/synthetic/${"long-path-segment/".repeat(18)}probe.ts:${index + 1}:1)`,
  ).join("\n");
  const malformedLine = "not-json: synthetic malformed log line";
  const fixtureLines = [
    JSON.stringify({ ts: "2035-06-01T10:00:00.000Z", level: "info", event: "STORE_READY", message: "Synthetic older row" }),
    malformedLine,
    JSON.stringify({ ts: "2035-06-01T10:01:00.000Z", level: "error", event: "RPC_ERROR", message: "Synthetic newest row", stack: newestStack }),
  ];
  let failedAttempts = 0;
  let allowFixture = false;
  let successfulResponses = 0;
  const rpcUrl = "**/api/rpc/diagnosticsLogsTail**";
  await page.route(rpcUrl, async (route) => {
    if (!allowFixture) {
      failedAttempts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ json: { code: "FIXTURE_UNAVAILABLE", message: "retry fixture" } }),
      });
      return;
    }
    successfulResponses += 1;
    await route.fulfill({ json: { json: { file: "2035-06-01.jsonl", lines: fixtureLines } } });
  });

  try {
    await signIn(page, { startPath: "/diagnostics", landingTestId: "diagnostics-title" });
    await expect(page.getByRole("button", { name: /إعادة المحاولة/ })).toBeVisible({ timeout: 15_000 });
    expect(failedAttempts).toBeGreaterThan(0);
    allowFixture = true;
    const retryResponse = page.waitForResponse((response) => response.url().includes("/api/rpc/diagnosticsLogsTail"));
    await page.getByRole("button", { name: /إعادة المحاولة/ }).click();
    await retryResponse;
    expect(successfulResponses).toBe(1);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const list = page.getByTestId("diagnostics-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("Synthetic newest row");
    await expect(list).toContainText("Synthetic older row");
    await expect(list).toContainText("not-json: synthetic malformed log line");
    const rows = page.getByTestId("diagnostics-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Synthetic newest row");
    await expect(rows.last()).toContainText("Synthetic older row");
    await expect(page.locator("[data-testid='diagnostics-list'] > pre")).toHaveText(malformedLine);

    const row = rows.first();
    const details = row.locator("details");
    const summary = row.locator("summary");
    const stack = details.locator("pre");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(stack).toBeHidden();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(stack).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(stack).toHaveText(newestStack);

    for (const dark of [false, true]) {
      await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
      for (const viewport of [{ width: 1000, height: 600 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        const measured = await page.evaluate(() => {
          const main = document.querySelector("main");
          const listElement = document.querySelector('[data-testid="diagnostics-list"]');
          const card = document.querySelector('[data-testid="diagnostics-row"]');
          const pre = card?.querySelector("details[open] pre");
          const neighbor = document.querySelector('[data-testid="diagnostics-title"]');
          if (!main || !listElement || !card || !pre || !neighbor) throw new Error("Expected diagnostics layout elements");
          const cardBounds = card.getBoundingClientRect();
          const neighborBounds = neighbor.getBoundingClientRect();
          return {
            viewport: document.documentElement.clientWidth,
            mainClient: main.clientWidth,
            mainScroll: main.scrollWidth,
            listClient: listElement.clientWidth,
            cardWidth: cardBounds.width,
            cardRight: cardBounds.right,
            neighborRight: neighborBounds.right,
            stackClient: pre.clientWidth,
            stackScroll: pre.scrollWidth,
          };
        });
        expect(measured.mainScroll).toBeLessThanOrEqual(measured.mainClient);
        expect(measured.cardWidth).toBeLessThanOrEqual(measured.listClient);
        expect(measured.cardRight).toBeLessThanOrEqual(measured.viewport);
        expect(measured.neighborRight).toBeLessThanOrEqual(measured.viewport);
        expect(measured.stackScroll).toBeGreaterThan(measured.stackClient);

        const scroll = await stack.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
          return { left: element.scrollLeft, max: element.scrollWidth - element.clientWidth };
        });
        expect(scroll.left).toBeGreaterThan(0);
        expect(scroll.left).toBe(scroll.max);
        await expect(stack).toHaveText(newestStack);
      }
    }
  } finally {
    await page.unroute(rpcUrl);
  }
});
