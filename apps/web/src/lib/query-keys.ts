/**
 * Prefix query keys for the cache families that a supplier-money write must
 * invalidate. They live outside `./rpc` on purpose: test files mock `@/lib/rpc`
 * wholesale, so a constant exported there disappears for any test that does not
 * re-export it (bun's `mock.module` is process-global).
 *
 * oRPC generates a query key as `[path, { input?, type }]`, so the first
 * element — the procedure path — is the prefix React Query's `invalidateQueries`
 * matches against. Procedures with a required input (debtsByParty, invoicesList,
 * activitiesList) have no single input to key a cross-party refresh on, hence the
 * literal prefixes.
 */

/** every per-party debts drill-down result */
export const DEBTS_BY_PARTY_QUERY_KEY = [["debtsByParty"]] as const;

/** every invoices-list page/filter result */
export const INVOICES_LIST_QUERY_KEY = [["invoicesList"]] as const;

/** every activities-list page result */
export const ACTIVITIES_LIST_QUERY_KEY = [["activitiesList"]] as const;
