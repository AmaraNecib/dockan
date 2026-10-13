/**
 * #184 — the ONE implementation of the opening-balance destination rule.
 *
 * #177/#180 made the server the only resolver of a typed supplier name, but the
 * confirmation dialog still mirrored the fold tie-break. This module is the
 * single home for that rule; the guarded bulk write and the read-only
 * `suppliersResolveName` query both call it, so the account the dialog names is
 * the account the server writes to.
 */

/** One supplier that folds to a normalized name. A name can match more than one
 * row after legacy duplicate creation (same `normalizeTextKey`, different text). */
export type NamedSupplierCandidate = { id: string; name: string; entries: number };

/**
 * The fold tie-break: prefer the entry-carrying party, then the lowest id.
 * Deterministic and total: equal entries compare ids as strings.
 */
export function pickOpeningSupplier(candidates: readonly NamedSupplierCandidate[]): NamedSupplierCandidate | undefined {
  return candidates.reduce<NamedSupplierCandidate | undefined>(
    (best, candidate) =>
      best === undefined || candidate.entries > best.entries || (candidate.entries === best.entries && candidate.id < best.id) ? candidate : best,
    undefined,
  );
}

/** The lowest id; used for the holder arm so two folded rows that both carry the
 * row's signature resolve identically from either call site. */
function lowestById(candidates: readonly NamedSupplierCandidate[]): NamedSupplierCandidate | undefined {
  return candidates.reduce<NamedSupplierCandidate | undefined>((best, candidate) => (best === undefined || candidate.id < best.id ? candidate : best), undefined);
}

/**
 * The destination for a typed name: the candidate already holding the row's
 * signature (so a lost-response retry stays on the original account), else the
 * tie-break winner. `undefined` means no candidate folds to the name — a write
 * would create one.
 *
 * `signatureHolds` is injected so the rule stays pure and the same function
 * serves the transaction write path and the read-only resolve query. Both arms
 * are order-independent, so the two call sites cannot disagree.
 */
export type OpeningDestinationResolution = {
  candidate: NamedSupplierCandidate;
  /** true when the candidate already held the row's signature (a retry) */
  holder: boolean;
};

export async function resolveOpeningDestination(
  candidates: readonly NamedSupplierCandidate[],
  signatureHolds: (candidate: NamedSupplierCandidate) => Promise<boolean>,
): Promise<OpeningDestinationResolution | undefined> {
  const holders: NamedSupplierCandidate[] = [];
  for (const candidate of candidates) {
    if (await signatureHolds(candidate)) holders.push(candidate);
  }
  const holder = lowestById(holders);
  if (holder !== undefined) return { candidate: holder, holder: true };
  const picked = pickOpeningSupplier(candidates);
  return picked === undefined ? undefined : { candidate: picked, holder: false };
}
