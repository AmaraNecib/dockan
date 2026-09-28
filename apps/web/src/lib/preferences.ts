import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Preferences } from "@dokan/contracts";

import { rpcClient } from "./rpc";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

/** How long a read stays fresh before a remount/focus refetches it. */
export const PREFERENCE_STALE_MS = 30_000;

/**
 * Read every preference in one cheap call. Throws on failure so React Query
 * keeps the query retryable: an errored query is refetched on the next
 * mount/focus, which is how a transient boot hiccup self-heals.
 */
export async function readPreferences(): Promise<Preferences> {
  const { values } = await rpcClient.preferencesGet();
  return values;
}

/**
 * Persist one preference and return the server's stored value, or null when
 * the write failed. This is a loopback call to local sqlite, so the caller can
 * simply await it instead of guessing.
 */
export async function writePreference(key: string, value: string): Promise<string | null> {
  try {
    const { value: stored } = await rpcClient.preferencesSet({ key, value });
    return stored;
  } catch {
    return null;
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
  /** Await the server, then install its value; never shows an unconfirmed guess. */
  setValue: (next: T) => void;
  /** Update from the current server value; a no-op while a write is in flight. */
  updateValue: (updater: (previous: T) => T) => void;
  /** true until the shared preferences read settles (success or failure). */
  isPending: boolean;
  /** true while this key's write is in flight; disable the control meanwhile. */
  isWriting: boolean;
}

/**
 * One preference from the shared preferences query.
 *
 * No optimistic state: a write awaits the server (a loopback call to local
 * sqlite, a few milliseconds) and the cache is then set from the server's own
 * returned value. A failed write means the value did not change, so the query
 * keeps showing the server's value. The only local state is a synchronous
 * in-flight guard, so a double-click cannot issue two writes.
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
    staleTime: PREFERENCE_STALE_MS,
    // one immediate failure keeps the UI responsive; the errored query is
    // refetched on the next mount/focus, so a boot hiccup still self-heals
    retry: false,
    // another window's change is picked up when the owner comes back
    refetchOnWindowFocus: "always",
    refetchOnReconnect: true,
  });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const raw = query.data?.[key];
  const value = raw === undefined ? defaultValue : parse(raw);

  const setValue = useCallback(
    (next: T) => {
      // synchronous guard: two clicks in one tick cannot issue two writes
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      void writePreference(key, serialize(next))
        .then((stored) => {
          if (stored === null) return; // the write failed; the server value stands
          // install only the server's own returned value, and never create a
          // partial map: the cache holds full server reads only
          queryClient.setQueryData<Preferences>(PREFERENCES_QUERY_KEY, (previous) => {
            if (previous === undefined) return previous;
            return { ...previous, [key]: stored };
          });
        })
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [key, queryClient, serialize],
  );

  const updateValue = useCallback(
    (updater: (previous: T) => T) => {
      const currentRaw = queryClient.getQueryData<Preferences>(PREFERENCES_QUERY_KEY)?.[key];
      const current = currentRaw === undefined ? defaultValue : parse(currentRaw);
      setValue(updater(current));
    },
    [defaultValue, key, parse, queryClient, setValue],
  );

  return { value, setValue, updateValue, isPending: query.isPending, isWriting: pending };
}
