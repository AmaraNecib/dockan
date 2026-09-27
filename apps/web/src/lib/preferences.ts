import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Preferences } from "@dokan/contracts";

import { rpcClient } from "./rpc";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

/**
 * Read every preference in one cheap call.
 *
 * A failed read resolves to an empty map instead of throwing: this is the
 * server-side successor to the throwing-storage guard, so a broken server can
 * never hide a panel or crash the shell — callers fall back to their defaults.
 */
export async function readPreferences(): Promise<Preferences> {
  try {
    const { values } = await rpcClient.preferencesGet();
    return values;
  } catch {
    return {};
  }
}

/**
 * Persist one preference. A failed write must not break the in-memory toggle,
 * so the error is swallowed and the choice still applies for this session.
 */
export async function writePreference(key: string, value: string): Promise<void> {
  try {
    await rpcClient.preferencesSet({ key, value });
  } catch {
    // server unavailable: the in-memory choice still applies for this session
  }
}

export interface Preference<T> {
  value: T;
  setValue: (next: T) => void;
  /** true until the shared preferences read settles (success or failure). */
  isPending: boolean;
}

/**
 * One preference from the shared preferences query. The value is derived from
 * the query cache, so every hook on the same key re-renders on a write without
 * a refetch; writes go to the server in the background.
 */
export function usePreference<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string | undefined) => T,
  serialize: (value: T) => string,
): Preference<T> {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: readPreferences,
    // preferences change only through this app; no background churn
    staleTime: Infinity,
  });
  const value = parse(query.data?.[key]);
  const setValue = useCallback(
    (next: T) => {
      const serialized = serialize(next);
      // an in-flight initial fetch must not overwrite this optimistic write
      // when it resolves with the pre-write value
      void queryClient.cancelQueries({ queryKey: PREFERENCES_QUERY_KEY });
      queryClient.setQueryData<Preferences>(PREFERENCES_QUERY_KEY, (previous) => ({
        ...previous,
        [key]: serialized,
      }));
      void writePreference(key, serialized);
    },
    [key, queryClient, serialize],
  );
  return { value, setValue, isPending: query.isPending };
}
