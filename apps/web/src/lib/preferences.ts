import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Preferences } from "@dokan/contracts";

import { rpcClient } from "./rpc";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

/** How long a read stays fresh before a remount/focus refetches it. */
export const PREFERENCE_STALE_MS = 30_000;

/** Transient write attempts; the server upsert is idempotent, so retries are safe. */
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_MS = 50;

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

async function persistPreference(key: string, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      const { value: stored } = await rpcClient.preferencesSet({ key, value });
      return stored === value;
    } catch {
      if (attempt < WRITE_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_MS * (attempt + 1)));
      }
    }
  }
  return false;
}

// Per-key write chains: a write starts only after the previous write for the
// same key settles, so an earlier choice can never land after a later one.
const writeTails = new Map<string, Promise<boolean>>();
let writeSequence = 0;
const latestWriteSequence = new Map<string, number>();

export interface PreferenceWrite {
  sequence: number;
  done: Promise<boolean>;
}

/** Queue a serialized, retrying write for one key. */
export function queuePreferenceWrite(key: string, value: string): PreferenceWrite {
  const sequence = ++writeSequence;
  latestWriteSequence.set(key, sequence);
  const tail = writeTails.get(key) ?? Promise.resolve(true);
  const done = tail.then(() => persistPreference(key, value));
  writeTails.set(key, done);
  return { sequence, done };
}

/** True when no newer write was queued for `key` after `sequence`. */
export function isLatestPreferenceWrite(key: string, sequence: number): boolean {
  return latestWriteSequence.get(key) === sequence;
}

/**
 * Imperative write seam. Resolves to whether the server stored the value; it
 * never throws. Ordered per key and retried on transient failures.
 */
export async function writePreference(key: string, value: string): Promise<boolean> {
  return queuePreferenceWrite(key, value).done;
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
  /** Update from the latest effective value, so rapid toggles cannot race. */
  updateValue: (updater: (previous: T) => T) => void;
  /** true until the shared preferences read settles (success or failure). */
  isPending: boolean;
}

/**
 * One preference from the shared preferences query.
 *
 * The shared cache only ever holds a full server read; an unconfirmed choice
 * lives in a local overlay until the write is confirmed (or reverted on
 * failure), so a write racing the first read can never leave the cache
 * partial. Writes are serialized per key, retried, and the last queued write
 * reconciles from the server. A finite staleTime plus refetch-on-focus is the
 * multi-window sync point for a POS that stays open.
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

  const [optimistic, setOptimistic] = useState<string | null>(null);
  const serverRaw = query.data?.[key];
  const effectiveRaw = optimistic ?? serverRaw;
  const value = effectiveRaw === undefined ? defaultValue : parse(effectiveRaw);

  // latest effective raw, read synchronously by rapid updaters
  const latestRaw = useRef<string | undefined>(effectiveRaw);
  latestRaw.current = effectiveRaw;

  // confirmed by the cache: this write reconciled, or another window read it
  useEffect(() => {
    if (optimistic !== null && serverRaw === optimistic) setOptimistic(null);
  }, [optimistic, serverRaw]);

  const commit = useCallback(
    (serialized: string) => {
      latestRaw.current = serialized;
      setOptimistic(serialized);
      const { sequence, done } = queuePreferenceWrite(key, serialized);
      void done.then((stored) => {
        // only the newest queued write reconciles; an older one must not undo it
        if (!isLatestPreferenceWrite(key, sequence)) return;
        const current = queryClient.getQueryData<Preferences>(PREFERENCES_QUERY_KEY);
        if (stored) {
          if (current !== undefined) {
            // fold the confirmed value into the full map (the response echo)
            queryClient.setQueryData<Preferences>(PREFERENCES_QUERY_KEY, { ...current, [key]: serialized });
          } else {
            // the first read has not landed yet: fetch the full map
            void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
          }
        } else {
          // the server rejected the change: stop claiming it, then restore truth
          setOptimistic((previous) => (previous === serialized ? null : previous));
          void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
        }
      });
    },
    [key, queryClient],
  );

  const setValue = useCallback((next: T) => commit(serialize(next)), [commit, serialize]);

  const updateValue = useCallback(
    (updater: (previous: T) => T) => {
      const currentRaw = latestRaw.current;
      const current = currentRaw === undefined ? defaultValue : parse(currentRaw);
      commit(serialize(updater(current)));
    },
    [commit, defaultValue, parse, serialize],
  );

  return { value, setValue, updateValue, isPending: query.isPending };
}
