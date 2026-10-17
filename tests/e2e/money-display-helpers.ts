import { expect, type Locator, type Page } from "@playwright/test";

/**
 * #254 — the money display's bidi proof.
 *
 * `textContent` and `innerText` return the LOGICAL string, so no DOM assertion
 * can tell that an amount's runs were reordered on screen; only real geometry
 * can (`.agents/wisdom/2026-10-01-rtl-dates-bidi-and-align.md`). This is the
 * same measurement `invoice-print-a4.spec.ts` already uses for the sheet: in an
 * RTL row the currency run is drawn to the LEFT of the isolated figures.
 */
export async function expectCurrencyLeftOfFigures(cell: Locator): Promise<void> {
  const figures = await cell.getByTestId("money-figures").boundingBox();
  const currency = await cell.getByTestId("money-currency").boundingBox();
  expect(figures).not.toBeNull();
  expect(currency).not.toBeNull();
  // a collapsed run would satisfy the comparison below by accident
  expect(figures?.width ?? 0).toBeGreaterThan(0);
  expect(currency?.width ?? 0).toBeGreaterThan(0);
  expect((currency?.x ?? 0) + (currency?.width ?? 0)).toBeLessThanOrEqual((figures?.x ?? Number.MAX_SAFE_INTEGER) + 1);
}

/**
 * A lane's visual evidence for a change to how something LOOKS (#259): a
 * screenshot at the moment the assertion runs. CI never sets
 * `E2E_EVIDENCE_DIR`, so CI writes nothing.
 */
export async function captureEvidence(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (dir === undefined) return;
  await page.screenshot({ path: `${dir}/${name}.png` });
}
