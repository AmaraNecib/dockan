/**
 * Focus the element rendered with this testid, and report whether focus moved.
 *
 * Returns `false` when the testid is not in the document, so a caller can fall
 * back deliberately instead of silently leaving focus on `document.body`. The
 * helper owns no fallback policy: which testid to try, in what order, and what
 * to do when one is gone, stay with the caller (issue #248).
 */
export function focusByTestId(testId: string): boolean {
  const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (target === null) return false;
  target.focus();
  // "moved" means the element actually owns focus now; a non-focusable match
  // would otherwise report a success the caller could not fall back from
  return document.activeElement === target;
}
