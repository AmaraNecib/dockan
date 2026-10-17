import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { captureEvidence, expectCurrencyLeftOfFigures } from "./money-display-helpers";
import { sampleNoWrite } from "./no-write-window";

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
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. the bulk رصيد افتتاحي screen: create a supplier inline with 800 نسالوه
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-new-name").fill(openingSupplierName);
  await page.getByTestId("opening-balance-new-amount").fill("800");
  await page.getByTestId("opening-balance-save").click();

  const saved = page.getByTestId("opening-balance-saved");
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(openingSupplierName);
  await expect(saved).toContainText("800 دج");
  await page.getByTestId("opening-balance-done").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // 4. the new supplier exists and carries its opening balance
  await page.getByRole("link", { name: openingSupplierName }).click();
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

  // the account row names the adjustment and its direction
  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("supplier-entry-kind-ADJUSTMENT").first()).toBeVisible();
  await expect(page.getByTestId("supplier-entry-direction").first()).toContainText("يسالنا");

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
  await page.getByTestId("opening-balance-new-name").fill(creditSupplierName);
  await chooseSelectOption(page, page.getByTestId("opening-balance-new-direction"), "يسالنا");
  await page.getByTestId("opening-balance-new-amount").fill("100000");
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toBeVisible();

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
  // isolated figures run (a sibling `−` is the run bidi displaced to the far end
  // of the row), and the currency drawn to the LEFT of the figures.
  const creditRow = page.getByTestId("debts-person").filter({ hasText: creditSupplierName });
  const creditTotal = creditRow.getByTestId("debts-person-total");
  await expect(creditTotal.getByTestId("money-figures")).toHaveText("− 100,000");
  await expect(creditTotal).toContainText("− 100,000 دج");
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
  await page.getByTestId("opening-balance-new-name").fill(typedName);
  await page.getByTestId("opening-balance-new-amount").fill("300");
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
  expect(landed.account?.balance).toBe(800);
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

  await page.route("**/api/rpc/suppliersResolveName", async (route) => {
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
  await page.getByTestId("opening-balance-new-name").fill(name);
  await page.getByTestId("opening-balance-new-amount").fill("500");

  // arm the lookup acknowledgement BEFORE the click so the assertion is causally
  // ordered rather than a wall-clock wait
  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveName"));
  await page.getByTestId("opening-balance-save").click();

  // leave while the lookup is still running
  await page.getByTestId("opening-balance-cancel").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // let the held lookup answer: the abandoned attempt must not write over the
  // window that follows the response, not just at the instant it lands
  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveName");
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
  await page.route("**/api/rpc/suppliersResolveName", async (route) => {
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
  await page.getByTestId("opening-balance-new-name").fill(carriedName);
  await page.getByTestId("opening-balance-new-amount").fill("500");

  // the first submit resolves and opens the dialog naming the carried account
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-confirm")).toBeVisible();

  // a second main Save starts a NEW lookup while the dialog stays open
  const secondLookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveName"));
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
  await page.unroute("**/api/rpc/suppliersResolveName");
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

  await page.route("**/api/rpc/suppliersResolveName", async (route) => {
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
  await page.getByTestId("opening-balance-new-name").fill(name);
  await page.getByTestId("opening-balance-new-amount").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveName"));
  await page.getByTestId("opening-balance-save").click();
  await page.getByTestId("opening-balance-back").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveName");
  await expectNoWriteDuring(page, () => wrote);
});

/**
 * The browser Back button is a router-driven unmount with no page-level click
 * handler; the unmount cleanup alone must invalidate the in-flight lookup.
 */
test("browser back while the name lookup is pending writes nothing (issue 184 review round 1)", async ({ page }) => {
  await signIn(page);
  const name = `مورد رجوع-متصفح-${Date.now()}`;

  await page.route("**/api/rpc/suppliersResolveName", async (route) => {
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
  await page.getByTestId("opening-balance-new-name").fill(name);
  await page.getByTestId("opening-balance-new-amount").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveName"));
  await page.getByTestId("opening-balance-save").click();

  await page.goBack(); // router-driven unmount, no page onClick
  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveName");
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
  await page.route("**/api/rpc/suppliersResolveName", async (route) => {
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
  await page.getByTestId("opening-balance-new-name").fill(name);
  await page.getByTestId("opening-balance-new-amount").fill("500");

  const lookup = page.waitForResponse((response) => response.url().includes("/api/rpc/suppliersResolveName"));
  await page.getByTestId("opening-balance-save").click();

  // a sidebar link, not a page control: the unmount guard must invalidate
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();

  await lookup;
  await page.unroute("**/api/rpc/suppliersResolveName");
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
  const nameField = page.getByTestId("opening-balance-new-name");
  await nameField.fill(typedName);
  await page.getByTestId("opening-balance-new-amount").fill("300");
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
  expect(carriedAfter.account?.balance).toBe(700);

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
