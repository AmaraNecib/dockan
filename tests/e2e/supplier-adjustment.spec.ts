import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { captureEvidence, expectCurrencyLeftOfFigures } from "./money-display-helpers";
import { sampleNoWrite } from "./no-write-window";

// #254 evidence (#259): the money display is a VISUAL change, so this spec can
// record a video at real user pace when a lane asks for one. CI never sets
// E2E_VIDEO, so CI records nothing.
test.use({ video: process.env.E2E_VIDEO === "1" ? "on" : "off" });

/** The inputs this spec sends over the issue-184 RPC helper. */
type RpcInput =
  | { name: string }
  | { id: string }
  | { supplierId: string; direction: "WE_OWE" | "THEY_OWE"; amount: number; reason: string; occurredAt: string };

/** Call one oRPC procedure from the page and return its output (issue 184). */
async function rpc<T>(page: Page, procedure: string, json: RpcInput): Promise<T> {
  const result = await page.evaluate(
    async ({ procedure, json }) => {
      const response = await fetch(`/api/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      });
      if (!response.ok) throw new Error(`${procedure} failed with HTTP ${response.status}`);
      // SAFETY: the oRPC fetch link answers a successful procedure call with the
      // `{ json: <declared output> }` envelope
      const body = (await response.json()) as { json: unknown };
      return body.json;
    },
    { procedure, json },
  );
  // SAFETY: the caller's T names the procedure's declared output, which the
  // envelope carries
  return result as T;
}

/**
 * Assert that no opening-balance write lands during a bounded window after the
 * page's next steps have run. `wrote` starts false, so a single immediate read
 * passes vacuously and would miss a late write (review round 2 finding 2);
 * sample the flag for a real interval and require every sample false. The
 * sampler (round 5) keeps going until BOTH the observed window and the minimum
 * sample count hold, so a slow CI scheduler extends the sampling instead of
 * failing a window no write ever touched.
 */
async function expectNoWriteDuring(page: Page, wrote: () => boolean, windowMs = 1500): Promise<void> {
  await sampleNoWrite({
    windowMs,
    check: (observedMs) => {
      expect(wrote(), `an opening-balance write landed ${observedMs}ms into the no-write window`).toBe(false);
    },
    wait: (ms) => page.waitForTimeout(ms),
  });
  // the loop breaks on a fresh sample with no wait after it, so this is a
  // belt-and-braces final read rather than a needed tail check
  expect(wrote()).toBe(false);
}

/**
 * #176 — supplier adjustments (تسوية) and the bulk opening-balance screen
 * (رصيد افتتاحي). Records an opening balance from the bulk screen, then an
 * invoice-linked خصم on the supplier page, and checks that the account balance
 * and the invoice's remaining agree.
 */
test("supplier adjustment: a bulk رصيد افتتاحي and a linked خصم agree with the invoice", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `تسوية-تصنيف-${stamp}`;
  const itemName = `تسوية-منتج-${stamp}`;
  const supplierName = `تسوية-مورد-${stamp}`;
  const openingSupplierName = `رصيد-افتتاحي-مورد-${stamp}`;

  // 1. seed a category + item (cost 1000)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("1000");
  await page.getByLabel("سعر البيع (دج)").fill("1500");
  await page.getByTestId("item-save").click();

  // 2. purchase 5 units @1000 from a NEW supplier (paid 0 → the whole 5000 owed)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-name").fill(supplierName);
  await page.getByTestId("purchase-supplier-create-save").click();

  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-paid").fill("0");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("SUP-");
  // SAFETY: the saved card always formats purchase numbers as SUP-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/SUP-\d+/)![0]!;

  // 3. the bulk رصيد افتتاحي screen: THREE new suppliers in one pass (#255). The
  // owner types several parties and saves them in ONE request, so the add control
  // must append a row, keep the rows already typed, and the saved card must name
  // all three. Row 0 keeps the default direction, 800 يسالنا
  // (WE_OWE — a debt the shop owes the supplier, #260).
  const secondOpeningSupplier = `${openingSupplierName}-2`;
  const thirdOpeningSupplier = `${openingSupplierName}-3`;
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(openingSupplierName);
  await page.getByTestId("opening-balance-typed-amount-0").fill("800");
  // #252 — the direction control reads a Darija label, never the raw enum value.
  // Before the fix this trigger printed `WE_OWE` while its own popup printed the
  // Arabic items (`SelectValue` with no `items` map on the root).
  const directionSelect = page.getByTestId("opening-balance-typed-direction-0");
  await expect(directionSelect).toContainText("يسالنا");
  await expect(directionSelect).not.toContainText("WE_OWE");
  await expect(directionSelect).not.toContainText("THEY_OWE");

  await page.getByTestId("opening-balance-add-row").click();
  // the control focuses the row it added: the owner types the next party without
  // reaching for the mouse
  await expect(page.getByTestId("opening-balance-typed-name-1")).toBeFocused();
  await page.keyboard.type(secondOpeningSupplier);
  await page.getByTestId("opening-balance-typed-amount-1").fill("150");
  await page.getByTestId("opening-balance-add-row").click();
  await page.getByTestId("opening-balance-typed-name-2").fill(thirdOpeningSupplier);
  await page.getByTestId("opening-balance-typed-amount-2").fill("250");

  // the first row is its own draft, and the count on the save reads the Arabic
  // plural for three
  await expect(page.getByTestId("opening-balance-typed-name-0")).toHaveValue(openingSupplierName);
  await expect(page.getByTestId("opening-balance-typed-amount-0")).toHaveValue("800");
  await expect(page.getByTestId("opening-balance-save")).toHaveText("حفظ 3 تسويات");

  // count EVERY matching write, not just the first: `waitForResponse` resolves on
  // the first response and cannot see a second request (review round 6 finding 2)
  const openingRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) openingRequests.push(request.url());
  });
  const openingWrite = page.waitForResponse(
    (response) => response.url().includes("/api/rpc/suppliersOpeningBalances") && response.request().method() === "POST",
  );
  await page.getByTestId("opening-balance-save").click();
  // SAFETY: the oRPC fetch link answers a successful procedure call with the
  // `{ json: <declared output> }` envelope
  const openingResult = (await (await openingWrite).json()) as { json: { created: number } };
  // the acceptance criterion: three parties, three settlements, ONE request
  expect(openingResult.json.created).toBe(3);

  const saved = page.getByTestId("opening-balance-saved");
  await expect(saved).toBeVisible();
  // exactly one write reached the server: the count is read after the app's own
  // completion signal (the saved card) and demands one, so a second opening-balance
  // request fails HERE even though the first response still carries `created: 3`
  // (review round 6 finding 2)
  expect(openingRequests).toHaveLength(1);

  // every added row landed with ITS OWN amount, not just its name: each assertion
  // is scoped to the row that names the supplier, so a batch that swapped 150 and
  // 250 between rows — which still names all three — cannot pass (review round 6
  // finding 1). Rows are found by their EXACT name because the three share a prefix.
  const savedRow = (name: string) => saved.getByTestId("opening-balance-saved-row").filter({ has: page.getByText(name, { exact: true }) });
  await expect(savedRow(openingSupplierName)).toContainText("800 دج");
  // #260 — the saved card names the same direction the ledger recorded: 800 WE_OWE
  // is a debt, so the row reads يسالنا beside the amount
  await expect(savedRow(openingSupplierName)).toContainText("يسالنا");
  await expect(savedRow(secondOpeningSupplier)).toContainText("150 دج");
  await expect(savedRow(thirdOpeningSupplier)).toContainText("250 دج");
  await page.getByTestId("opening-balance-done").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // 4. the new supplier exists and carries its opening balance. `exact` because
  // the other two rows of the batch share this name as a prefix
  await page.getByRole("link", { name: openingSupplierName, exact: true }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("800 دج");

  // 5. the purchased supplier shows the charge
  await page.goto("/suppliers");
  await page.getByRole("link", { name: supplierName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("5,000 دج");

  // 6. an invoice-linked خصم of 500: the balance and the invoice both drop
  await page.getByTestId("supplier-action-adjust").click();
  await page.getByTestId("supplier-adjust-direction-they-owe").click();
  await page.getByTestId("supplier-adjust-amount").fill("500");
  await page.getByTestId("supplierAdjustPresetDiscount").click();
  await page.getByTestId("supplier-adjust-link").check();
  await chooseSelectOption(page, page.getByTestId("supplier-adjust-invoice"), invoiceNumber);
  await expect(page.getByTestId("supplier-adjust-preview-remaining")).toContainText("4,500 دج");
  await page.getByTestId("supplier-adjust-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("4,500 دج");

  // the account row names the adjustment and its direction (linked خصم = THEY_OWE = نسالوه, #260)
  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("supplier-entry-kind-ADJUSTMENT").first()).toBeVisible();
  await expect(page.getByTestId("supplier-entry-direction").first()).toContainText("نسالوه");

  // 7. the invoice agrees: remaining 4500, the 500 surfaced as settled credit
  await page.getByTestId("party-tab-invoices").click();
  await page.getByTestId("party-invoices").getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toHaveText("4,500 دج");
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText("500 دج");

  // 8. #180 — a supplier whose account is net in credit shows the credit label
  // on the /debts group total, never a bare negative number
  const creditSupplierName = `رصيد-دائن-${stamp}`;
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await page.getByTestId("opening-balance-typed-name-0").fill(creditSupplierName);
  await chooseSelectOption(page, page.getByTestId("opening-balance-typed-direction-0"), "نسالوه");
  await page.getByTestId("opening-balance-typed-amount-0").fill("100000");
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toBeVisible();
  // #260 — the saved card's credit row keeps the credit word beside the amount
  await expect(
    page.getByTestId("opening-balance-saved").getByTestId("opening-balance-saved-row").filter({ has: page.getByText(creditSupplierName, { exact: true }) }),
  ).toContainText("نسالوه");

  await page.goto("/debts");
  await expect(page.getByTestId("debts-group-weowe-credit")).toContainText("رصيد لنا عند الموردين");
  // the amount renders as a positive figure under the credit label: the
  // currency suffix alone would also pass for a negative value
  await expect(page.getByTestId("debts-group-weowe-total")).toContainText("دج");
  await expect(page.getByTestId("debts-group-weowe-total")).not.toContainText("-");

  // the lane's before/after image (#259) lands before the assertions the #254
  // change moves; the credit row is already on the page
  await captureEvidence(page, "debts-supplier-credit-row");

  // #254 — the signed supplier-credit row: grouped digits, the sign INSIDE the
  // isolated figures run (a sibling sign is the run bidi displaced to the far end
  // of the row), and the currency drawn to the LEFT of the figures. The polarity
  // is #260's, merged while this PR was in flight: a credit is positive ("+").
  const creditRow = page.getByTestId("debts-person").filter({ hasText: creditSupplierName });
  const creditTotal = creditRow.getByTestId("debts-person-total");
  await expect(creditTotal.getByTestId("money-figures")).toHaveText("+ 100,000");
  await expect(creditTotal).toContainText("+ 100,000 دج");
  await expectCurrencyLeftOfFigures(creditTotal);
});

/**
 * #184 — the opening-balance confirmation dialog must name the account the
 * server will write to, even when two suppliers fold to one name. The typed
 * text here has three spaces; the entry-carrying twin's stored text has two, so
 * a client-side mirror of the tie-break could not produce the named string.
 */
test("a folded opening-balance name lands on the supplier the dialog names (issue 184)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const carriedName = `مورد  نزاع-${stamp}`; // double space: carries an entry, so the tie-break picks it
  const emptyName = `مورد نزاع-${stamp}`; // single space: folds to the same key, no entries
  const typedName = `مورد   نزاع-${stamp}`; // triple space: the owner's draft

  const carried = await rpc<{ id: string }>(page, "suppliersCreate", { name: carriedName });
  const empty = await rpc<{ id: string }>(page, "suppliersCreate", { name: emptyName });
  await rpc(page, "suppliersAdjust", { supplierId: carried.id, direction: "WE_OWE", amount: 500, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(typedName);
  await page.getByTestId("opening-balance-typed-amount-0").fill("300");
  await page.getByTestId("opening-balance-save").click();

  // the dialog names the SERVER's resolved text, not the typed string
  const dialog = page.getByTestId("opening-balance-confirm");
  await expect(dialog).toBeVisible();
  const named = await dialog.getByTestId("opening-balance-confirm-name").allTextContents();
  expect(named).toEqual([carriedName]);

  await page.getByTestId("opening-balance-confirm-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toContainText(carriedName);

  // the amount landed on the account the dialog named, not its empty twin
  const landed = await rpc<{ account?: { balance: number } | null }>(page, "suppliersGet", { id: carried.id });
  const twin = await rpc<{ account?: { balance: number } | null }>(page, "suppliersGet", { id: empty.id });
  expect(landed.account?.balance).toBe(-800);
  expect(twin.account?.balance).toBe(0);
});

/**
 * Review round 1, finding 1 (money): leaving while the name lookup is pending
 * must not write. The resolve is held open with a route delay so Cancel lands
 * mid-lookup; no opening-balance request may follow. Cancel stays enabled — a
 * hung lookup must never trap the owner.
 */
test("cancelling while the name lookup is pending writes nothing (issue 184 review round 1)", async ({ page }) => {
  await signIn(page);
  const name = `مورد معلّق-${Date.now()}`;

  await page.route("**/api/rpc/suppliersResolveNames", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  let wrote = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) wrote = true;
  });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(name);
  await page.getByTestId("opening-balance-typed-amount-0").fill("500");

  // arm the lookup acknowledgement BEFORE the click so the assertion is causally
  // ordered rather than a wall-clock wait
  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveNames"));
  await page.getByTestId("opening-balance-save").click();

  // leave while the lookup is still running
  await page.getByTestId("opening-balance-cancel").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // let the held lookup answer: the abandoned attempt must not write over the
  // window that follows the response, not just at the instant it lands
  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveNames");
  await expectNoWriteDuring(page, () => wrote);

  // and the name never materialized
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-table")).not.toContainText(name);
});

/**
 * Review round 2, finding 1: the dialog's OWN Cancel must invalidate the
 * in-flight attempt. Round 1 fixed the page-level Cancel; this path was left
 * live, so a second main Save (the dialog still open) followed by the dialog's
 * Cancel let the late lookup answer re-open the dismissed dialog.
 */
test("cancelling the dialog during a re-submit's lookup does not re-open it (issue 184 review round 2)", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString();
  const carriedName = `مورد حوار-${stamp}`;

  // an entry-carrying account so the first resolve opens the dialog
  const carried = await rpc<{ id: string }>(page, "suppliersCreate", { name: carriedName });
  await rpc(page, "suppliersAdjust", { supplierId: carried.id, direction: "WE_OWE", amount: 500, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

  // hold only the SECOND lookup on a gate the test releases AFTER the cancel, so
  // the cancel provably lands while that resolve is unanswered (not a wall-clock
  // race that a slow CI could lose in the wrong direction)
  let lookups = 0;
  let releaseSecond: () => void = () => undefined;
  let markSecondOnWire: () => void = () => undefined;
  const secondOnWire = new Promise<void>((resolve) => { markSecondOnWire = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/rpc/suppliersResolveNames", async (route) => {
    lookups += 1;
    if (lookups === 2) {
      markSecondOnWire();
      await secondGate;
    }
    await route.continue();
  });
  let wrote = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) wrote = true;
  });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(carriedName);
  await page.getByTestId("opening-balance-typed-amount-0").fill("500");

  // the first submit resolves and opens the dialog naming the carried account
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-confirm")).toBeVisible();

  // a second main Save starts a NEW lookup while the dialog stays open
  const secondLookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveNames"));
  await page.getByTestId("opening-balance-save").click();
  await secondOnWire; // the second resolve is on the wire and unanswered

  // the DIALOG's own Cancel lands while that lookup is still pending
  await page.getByTestId("opening-balance-confirm-cancel").click();
  await expect(page.getByTestId("opening-balance-confirm")).toHaveCount(0);
  releaseSecond();

  // the held lookup settles: the abandoned attempt must neither write nor
  // re-open the dismissed dialog over a bounded window
  await secondLookup;
  expect(lookups).toBeGreaterThanOrEqual(2); // positive control: a second resolve ran
  await page.unroute("**/api/rpc/suppliersResolveNames");
  await expectNoWriteDuring(page, () => wrote);
  await expect(page.getByTestId("opening-balance-confirm")).toHaveCount(0);

  // positive control for the write listener: a real confirmed save IS observed,
  // so the no-write window above cannot pass on a broken request matcher
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-confirm")).toBeVisible();
  await page.getByTestId("opening-balance-confirm-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toContainText(carriedName);
  expect(wrote).toBe(true);
});

/**
 * The back link is a second leave control; it invalidates the in-flight attempt
 * via its click handler rather than relying on the deferred unmount commit.
 */
test("leaving via the back link while the lookup is pending writes nothing (issue 184 review round 1)", async ({ page }) => {
  await signIn(page);
  const name = `مورد رجوع-${Date.now()}`;

  await page.route("**/api/rpc/suppliersResolveNames", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  let wrote = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) wrote = true;
  });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(name);
  await page.getByTestId("opening-balance-typed-amount-0").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveNames"));
  await page.getByTestId("opening-balance-save").click();
  await page.getByTestId("opening-balance-back").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveNames");
  await expectNoWriteDuring(page, () => wrote);
});

/**
 * The browser Back button is a router-driven unmount with no page-level click
 * handler; the unmount cleanup alone must invalidate the in-flight lookup.
 */
test("browser back while the name lookup is pending writes nothing (issue 184 review round 1)", async ({ page }) => {
  await signIn(page);
  const name = `مورد رجوع-متصفح-${Date.now()}`;

  await page.route("**/api/rpc/suppliersResolveNames", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  let wrote = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) wrote = true;
  });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(name);
  await page.getByTestId("opening-balance-typed-amount-0").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveNames"));
  await page.getByTestId("opening-balance-save").click();

  await page.goBack(); // router-driven unmount, no page onClick
  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveNames");
  await expectNoWriteDuring(page, () => wrote);
});

/**
 * A navigation the page does not own: the app-shell sidebar has no page-level
 * click handler, so only the layout-effect unmount guard invalidates the
 * in-flight lookup (issue 184 review round 2). This is a path guard, not a
 * discriminator of the layout-effect timing: the held response arrives well after
 * the unmount commit, so it would also pass on a deferred passive cleanup.
 */
test("leaving via the sidebar while the name lookup is pending writes nothing (issue 184 review round 2)", async ({ page }) => {
  await signIn(page);
  const name = `مورد قائمة-${Date.now()}`;

  // hold the lookup open across the navigation, like the back-link / browser-back
  // tests; the sidebar has no page-level onClick to invalidate on
  await page.route("**/api/rpc/suppliersResolveNames", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  let wrote = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/rpc/suppliersOpeningBalances")) wrote = true;
  });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-typed-name-0").fill(name);
  await page.getByTestId("opening-balance-typed-amount-0").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveNames"));
  await page.getByTestId("opening-balance-save").click();

  // a sidebar link, not a page control: the unmount guard must invalidate
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();

  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveNames");
  await expectNoWriteDuring(page, () => wrote);
});

/**
 * Review round 1, finding 2: editing the typed name to a different supplier
 * while the confirmation is open must clear the stale destination, so filling
 * the previously-confirmed supplier's row is a valid batch, not a conflict.
 */
test("editing the typed name away from the confirmed one keeps the batch saveable (issue 184 review round 1)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const carriedName = `مورد  متغير-${stamp}`; // double space: carries an entry
  const foldedName = `مورد متغير-${stamp}`; // single space: folds to the same key
  const typedName = `مورد   متغير-${stamp}`; // triple space: what the owner types first
  const freshName = `مورد مستقل-${stamp}`; // a genuinely different supplier

  const carried = await rpc<{ id: string }>(page, "suppliersCreate", { name: carriedName });
  await rpc<{ id: string }>(page, "suppliersCreate", { name: foldedName });
  await rpc(page, "suppliersAdjust", { supplierId: carried.id, direction: "WE_OWE", amount: 500, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  const nameField = page.getByTestId("opening-balance-typed-name-0");
  await nameField.fill(typedName);
  await page.getByTestId("opening-balance-typed-amount-0").fill("300");
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-confirm")).toBeVisible();

  // edit the typed name to a DIFFERENT supplier while the dialog is open: the
  // confirmation must close and its destination snapshot must be dropped
  await nameField.fill(freshName);
  await expect(page.getByTestId("opening-balance-confirm")).toHaveCount(0);

  // fill the carried supplier's existing row; the raw aria-label prefix
  // disambiguates the folded twin whose rendered text is identical
  await page.locator(`[data-testid="opening-balance-amount"][aria-label^="${carriedName}:"]`).fill("200");
  await expect(page.getByTestId("opening-balance-blocked")).toHaveCount(0);
  await expect(page.getByTestId("opening-balance-save")).toBeEnabled();

  // saving re-resolves the edited row and writes both accounts
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-confirm")).toBeVisible();
  await page.getByTestId("opening-balance-confirm-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toBeVisible();

  const carriedAfter = await rpc<{ account?: { balance: number } | null }>(page, "suppliersGet", { id: carried.id });
  expect(carriedAfter.account?.balance).toBe(-700);

  await page.getByTestId("opening-balance-done").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();
  await page.getByRole("link", { name: freshName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("300 دج");
});

/** Open the bulk screen and return the amount input for one supplier's row. */
async function openBalanceAmountFor(page: Page, supplierName: string) {
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  const amount = page.locator(`[data-testid="opening-balance-amount"][aria-label^="${supplierName}:"]`);
  await expect(amount).toBeVisible();
  return amount;
}

/**
 * #204 — a filled amount must never be dropped silently when a background
 * refresh removes its supplier. Fill the row, delete the supplier elsewhere
 * (here: over the RPC, with no event reaching this tab), trigger the
 * refetch-on-focus path, and assert the owner is shown the named loss and the
 * save is blocked until they acknowledge it.
 */
test("a refresh that removes a filled row's supplier names the loss and blocks the save (#204)", async ({ page }) => {
  await signIn(page);
  const supplierName = `مورد-زائل-${Date.now()}`;
  const supplier = await rpc<{ id: string }>(page, "suppliersCreate", { name: supplierName });

  const amount = await openBalanceAmountFor(page, supplierName);
  await amount.fill("700");

  // the supplier is deleted elsewhere, then the page refetches as it does on focus
  await rpc(page, "suppliersDelete", { id: supplier.id });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

  // the row is gone, but the amount is NOT silently dropped: the notice names the
  // supplier and shows the amount
  await expect(amount).toHaveCount(0);
  const notice = page.getByTestId("opening-balance-removed");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(supplierName);
  await expect(page.getByTestId("opening-balance-removed-row")).toContainText("700");
  await expect(page.getByTestId("opening-balance-save")).toBeDisabled();

  // acknowledging the loss clears it and re-enables the save
  await page.getByTestId("opening-balance-removed-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("opening-balance-save")).toBeEnabled();
});

/**
 * #254 round 3 — the removed-row amount is a direct child of a `flex flex-wrap`
 * row, so as two sibling spans it was two flex ITEMS: a narrow row could push
 * the currency onto a line without its number. Both runs are one atomic RTL
 * wrapper now, so squeezing the row to the digits' own width must still leave
 * the currency on the digits' line.
 */
test("the removed-row amount keeps its currency beside its digits in a narrow row (#254 round 3)", async ({ page }) => {
  // a narrow phone, because the finding is about wrapping
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const supplierName = `مورد-ضيق-${Date.now()}`;
  const supplier = await rpc<{ id: string }>(page, "suppliersCreate", { name: supplierName });

  const amount = await openBalanceAmountFor(page, supplierName);
  await amount.fill("700");
  await rpc(page, "suppliersDelete", { id: supplier.id });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

  const row = page.getByTestId("opening-balance-removed-row");
  const figures = row.getByTestId("money-figures");
  const currency = row.getByTestId("money-currency");
  await expect(figures).toBeVisible();
  await expect(currency).toBeVisible();

  // exactly as wide as the digits: the currency cannot fit beside them on this
  // line, so a splittable amount pushes it onto the next one
  const digits = await figures.boundingBox();
  expect(digits).not.toBeNull();
  await row.evaluate((element, width) => {
    // SAFETY: the locator is `opening-balance-removed-row`, an `<li>` in the page's own
    // markup, so the element is an HTMLElement at runtime and it has a style object.
    (element as HTMLElement).style.maxWidth = `${width}px`;
  }, Math.ceil(digits?.width ?? 0) + 2);

  // widen again so the still shows the SAME squeezed row: at 390 px the nav
  // sheet covers it, and the squeezed row is what is measured either way
  await page.setViewportSize({ width: 1000, height: 844 });
  await captureEvidence(page, "money-narrow-row");

  const figureBox = await figures.boundingBox();
  const currencyBox = await currency.boundingBox();
  expect(figureBox).not.toBeNull();
  expect(currencyBox).not.toBeNull();
  // the same line: under half an em of vertical drift
  expect(Math.abs((figureBox?.y ?? 0) - (currencyBox?.y ?? 0))).toBeLessThan(4);
});

/**
 * The negative #204 pins: an UNFILLED row whose supplier vanishes on the same
 * refresh still drops without a warning, so ordinary refreshes stay quiet.
 */
test("a refresh that removes an unfilled row's supplier drops it without a warning (#204)", async ({ page }) => {
  await signIn(page);
  const supplierName = `مورد-فارغ-${Date.now()}`;
  const supplier = await rpc<{ id: string }>(page, "suppliersCreate", { name: supplierName });

  const amount = await openBalanceAmountFor(page, supplierName);

  await rpc(page, "suppliersDelete", { id: supplier.id });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

  await expect(amount).toHaveCount(0);
  await expect(page.getByTestId("opening-balance-removed")).toHaveCount(0);
});
