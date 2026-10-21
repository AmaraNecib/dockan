/**
 * Find a required element, or fail with the selector that was missing.
 *
 * The alternative in a test is `querySelector(...)!`, which the repo now forbids
 * (#338): a non-null assertion reports the failure at the first property access,
 * far from the line that actually broke and usually as "cannot read properties of
 * null". Naming the selector is the difference between a five-second fix and a
 * bisect.
 *
 * For an element the test EXPECTS to be absent, use `querySelector` and assert on
 * it — this helper is for the ones the test needs.
 */
export function mustFind<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`the test could not find ${selector}`);
  return found;
}
