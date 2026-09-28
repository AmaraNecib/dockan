import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Preferences } from "@dokan/contracts";

import { rpcClient } from "./rpc";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

/**
 * Read every preference in one cheap call. Throws on failure so React Query
 * keeps the query retryable: an errored query is considered stale and is
 * refetched on the next mount/focus, which is how a transient boot hiccup
 * self-heals. Callers that need a default use `readPreference`.
 */
export async function readPreferences(): Promise<Preferences> {
  const { values } = await rpcClient.preferencesGet();
  return values;
}

/**
 * Imperative single-key read with the throwing-storage guard: any failure
 * yields undefined so the caller falls back to its default.
 */
export async function readPreference(key: string): Promise<string | undefined> {
  try {
    return (await readPreferences())[key];
  } catch {
    return undefined;
  }
}

/**
 * Persist one preference. Returns false (rather than throwing) on failure so
 * the in-memory choice still applies for this session and the caller can avoid
 * reconciling against a server that never saw the write.
 */
export async function writePreference(key: string, value: string): Promise<boolean> {
  try {
    await rpcClient.preferencesSet({ key, value });
    return true;
  } catch {
    return false;
  }
}

/** Shared codec: only the explicit string "true" is true. */
export function parseBooleanPreference(raw: string | undefined): boolean {
  return raw === "true";
}

export function serializeBooleanPreference(value: boolean): string {
  return String(value);
}

export interface Preference<T> {
  value: T;
  setValue: (next: T) => void;
  /** Update from the latest cached value, so rapid toggles cannot race. */
  updateValue: (updater: (previous: T) => T) => void;
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
    // one immediate failure keeps the UI responsive; the errored query is
    // refetched on the next mount, so a boot hiccup still self-heals
    retry: false,
  });
  const value = parse(query.data?.[key]);

  const setValue = useCallback(
    (next: T) => {
      const serialized = serialize(next);
      // an in-flight initial fetch must not overwrite this optimistic write
      void queryClient.cancelQueries({ queryKey: PREFERENCES_QUERY_KEY });
      queryClient.setQueryData<Preferences>(PREFERENCES_QUERY_KEY, (previous) => ({
        ...previous,
        [key]: serialized,
      }));
      void writePreference(key, serialized).then((wrote) => {
        // on success, reconcile the full map from the server: a write made
        // before the first read must not drop sibling preferences
        if (wrote) void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      });
    },
    [key, queryClient, serialize],
  );

  const updateValue = useCallback(
    (updater: (previous: T) => T) => {
      const current = parse(queryClient.getQueryData<Preferences>(PREFERENCES_QUERY_KEY)?.[key]);
      setValue(updater(current));
    },
    [key, parse, queryClient, setValue],
  );

  return { value, setValue, updateValue, isPending: query.isPending };
}
