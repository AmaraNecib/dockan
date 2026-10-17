import { expect, test } from "@playwright/test";

import { signIn } from "../../../tests/e2e/auth-helpers";

/**
 * #252 visual evidence. Not part of the suite (testDir is overridden by
 * `playwright.evidence.config.ts`); the same script runs against the unfixed
 * HEAD and against the fix, writing into `evidence/<EVIDENCE_PHASE>/`.
 *
 * Every step waits at human pace — the two options are read before one is
 * picked — so the recorded video shows the gesture a shopkeeper makes, not a
 * machine racing through it.
 */
const PHASE = process.env.EVIDENCE_PHASE ?? "after";
const DIR = `.scratch/reviews/252/evidence/${PHASE}`;

test("#252 — the direction control's labels", async ({ page }) => {
  // a real-pace walkthrough with deliberate reads; the 30s suite budget is for
  // assertions, not for a recorded human gesture
  test.setTimeout(180_000);
  await signIn(page);
  const stamp = Date.now().toString();
  const supplierName = `اتجاه-مورد-${stamp}`;

  // seed one supplier carrying an opening balance, through the real screen
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-new-name").fill(supplierName);
  await page.getByTestId("opening-balance-new-amount").fill("800");
  await page.screenshot({ path: `${DIR}/00-new-row.png` });
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toBeVisible();
  await page.getByTestId("opening-balance-saved").screenshot({ path: `${DIR}/01-saved.png` });
  await page.waitForTimeout(900);
  await page.getByTestId("opening-balance-done").click();

  // the seeded supplier now has a row: its direction select is the control the
  // ticket's screenshot 02 shows as `WE_OWE`
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  const row = page.getByTestId("opening-balance-row").filter({ hasText: supplierName });
  const trigger = row.getByTestId("opening-balance-direction");
  await expect(trigger).toBeVisible();
  await page.waitForTimeout(700);
  await trigger.screenshot({ path: `${DIR}/02-trigger.png` });

  // the dropdown: the two Arabic labels, exactly as screenshot 03 shows them
  await trigger.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.waitForTimeout(1400); // the owner reads both options before choosing
  await page.screenshot({ path: `${DIR}/03-dropdown.png` });
  const labels = await page.getByRole("option").allTextContents();
  const optionPicked = page.getByRole("option").nth(1); // THEY_OWE in source order
  const pickedLabel = (await optionPicked.textContent())?.trim() ?? "";
  console.log(`[${PHASE}] dropdown options: ${JSON.stringify(labels)}`);
  console.log(`[${PHASE}] option index 1 is THEY_OWE, its label: ${JSON.stringify(pickedLabel)}`);
  await page.waitForTimeout(900);
  await optionPicked.click();
  await page.waitForTimeout(900);
  await trigger.screenshot({ path: `${DIR}/04-trigger-after-pick.png` });
  // read the chosen label while the row is still on screen; the next steps navigate away
  const triggerAfterPick = await trigger.locator('[data-slot="select-value"]').textContent();
  console.log(`[${PHASE}] trigger after picking THEY_OWE: ${JSON.stringify(triggerAfterPick)}`);

  // the picker on the supplier page: label beside its own hint
  await page.goto("/suppliers");
  await page.getByRole("link", { name: supplierName }).click();
  await page.getByTestId("supplier-action-adjust").click();
  await expect(page.getByTestId("supplier-adjust-panel")).toBeVisible();
  await page.waitForTimeout(700);
  await page.getByTestId("supplier-adjust-panel").screenshot({ path: `${DIR}/05-adjust-panel.png` });

  // what the DOM actually said, for the report
  const panelCopy = await page.getByTestId("supplier-adjust-panel").evaluate((panel) => {
    const weOwe = panel.querySelector<HTMLElement>('[data-testid="supplier-adjust-direction-we-owe"]');
    const theyOwe = panel.querySelector<HTMLElement>('[data-testid="supplier-adjust-direction-they-owe"]');
    return {
      weOwe: { text: weOwe?.textContent ?? null, hint: weOwe?.getAttribute("title") ?? null },
      theyOwe: { text: theyOwe?.textContent ?? null, hint: theyOwe?.getAttribute("title") ?? null },
    };
  });
  console.log(`[${PHASE}] adjust panel: ${JSON.stringify(panelCopy)}`);

  // the check the ticket is about: the string on THEY_OWE is the "he owes us"
  // Darija, and picking it leaves the trigger showing a Darija word, never a raw
  // enum value
  const triggerValue = triggerAfterPick;
  expect(pickedLabel).toBe("نسالوه");
  expect(triggerValue).toBe("نسالوه");
});
