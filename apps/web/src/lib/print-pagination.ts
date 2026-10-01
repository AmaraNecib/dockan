/**
 * Printed-document pagination — split weighted lines into sheets from per-sheet
 * unit budgets. One unit is roughly one table row; a long description or note
 * costs more than one. The sheet count is the smallest one that actually fits
 * the weights (a sum of capacities is not enough: with uneven weights a prefix
 * can be too big to leave the closing sheet inside its budget), and each sheet
 * is filled to a feasible prefix closest to its even share.
 */

/** Unit budgets for the four sheet shapes a document can have. */
export interface PrintLineCaps {
  /** a first sheet that also closes (title + totals) */
  firstClosing: number;
  /** a closing sheet after the first */
  restClosing: number;
  /** a non-closing first sheet */
  firstContinuation: number;
  /** a non-closing sheet after the first */
  continuation: number;
}

/** Weight of one wrapped text cell: one row, plus one per overflow row. */
export function textRowUnits(text: string, charsPerRow: number): number {
  return Math.max(1, Math.ceil(text.length / charsPerRow));
}

export function totalUnits(costs: readonly number[]): number {
  return costs.reduce((sum, cost) => sum + cost, 0);
}

/** Capacity of each sheet in order, for a document of `pageCount` sheets. */
function capacitySequence(caps: PrintLineCaps, pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const isFirst = index === 0;
    const isClosing = index === pageCount - 1;
    if (isClosing) return isFirst ? caps.firstClosing : caps.restClosing;
    return isFirst ? caps.firstContinuation : caps.continuation;
  });
}

/**
 * Whether `costs` can be placed from `cursor` onto `capacities` in order. Each
 * sheet takes the longest prefix that fits (optimal for ordered items), and the
 * last sheet must absorb whatever is left.
 */
function fits(costs: readonly number[], cursor: number, capacities: readonly number[]): boolean {
  let index = cursor;
  for (const capacity of capacities) {
    let used = 0;
    while (index < costs.length && used + (costs[index] ?? 0) <= capacity) {
      used += costs[index] ?? 0;
      index += 1;
    }
    if (index >= costs.length) return true;
  }
  return index >= costs.length;
}

/**
 * The end index (exclusive) of each sheet's line slice; always at least one
 * sheet, and no sheet ever exceeds its capacity. A single line heavier than
 * every capacity falls back to one line per sheet so a pathological
 * description still prints instead of looping.
 */
export function paginateLineSlices(costs: readonly number[], caps: PrintLineCaps): number[] {
  if (costs.length === 0) return [0];

  // The sheet count may exceed the line count: the closing sheet can carry the
  // totals/payment block with ZERO lines (e.g. a payment-heavy invoice whose
  // line fits on an earlier sheet). At most one such empty sheet is useful, so
  // one extra is the bound; beyond it, a line is heavier than every cap and
  // falls back to one line per sheet.
  const maxPageCount = costs.length + 1;
  let pageCount = 1;
  while (pageCount <= maxPageCount && !fits(costs, 0, capacitySequence(caps, pageCount))) {
    pageCount += 1;
  }
  const forced = pageCount > maxPageCount;
  if (forced) pageCount = costs.length;

  const slices: number[] = [];
  let cursor = 0;
  for (let page = 0; page < pageCount; page += 1) {
    if (forced) {
      cursor += 1;
      slices.push(cursor);
      continue;
    }
    const isClosing = page === pageCount - 1;
    if (isClosing) {
      slices.push(costs.length);
      break;
    }
    if (cursor >= costs.length) {
      // all lines placed before the closing sheet: this continuation is empty
      slices.push(costs.length);
      continue;
    }
    const capacity = page === 0 ? caps.firstContinuation : caps.continuation;
    const laterCaps = capacitySequence(caps, pageCount).slice(page + 1);
    const target = Math.ceil(totalUnits(costs.slice(cursor)) / (pageCount - page));
    let take = 0;
    let score = Number.POSITIVE_INFINITY;
    let used = 0;
    for (let candidate = 1; cursor + candidate <= costs.length; candidate += 1) {
      used += costs[cursor + candidate - 1] ?? 0;
      if (used > capacity) break;
      if (!fits(costs, cursor + candidate, laterCaps)) continue;
      const candidateScore = Math.abs(used - target);
      if (candidateScore < score) {
        score = candidateScore;
        take = candidate;
      }
    }
    if (take === 0) take = 1; // a single line heavier than this sheet's budget
    cursor += take;
    slices.push(cursor);
  }
  return slices;
}
