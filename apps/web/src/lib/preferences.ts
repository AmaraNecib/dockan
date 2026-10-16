import { useRef, useState } from "react";
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
  /** Update from the current server value; a change made while a write is in
   * flight is remembered and sent once that write settles. */
  updateValue: (updater: (previous: T) => T) => void;
  /** true until the shared preferences read settles (success or failure). */
  isPending: boolean;
  /** true while this key's write is in flight; disable the control meanwhile. */
  isWriting: boolean;
  /** true when the read failed: "not set" and "we could not ask" are not the
   * same answer, and treating them as one is how a dismissal gets lost. */
  isError: boolean;
  /** true when the last write did not land; the server value still stands, and
   * the owner deserves to be told rather than watch the control snap back. */
  writeFailed: boolean;
}

// Keys whose write this page session still owes: in flight, or already landed.
// A failed write is removed (it is not a choice), so the one-time legacy import
// can take over a value the server rejected. The import consults this so a
// background migration can never overtake a newer choice that will land.
const writtenKeys = new Set<string>();

/** True while this page session has a write for `key` in flight or landed. */
export function hasPreferenceWrite(key: string): boolean {
  return writtenKeys.has(key);
}

type PreferenceWriteListener = (key: string, ok: boolean) => void;
const writeSettledListeners = new Set<PreferenceWriteListener>();

/**
 * Observe each preference write as it settles, after any queued follow-up.
 * The legacy sidebar import re-runs on a failed write through this: without it,
 * a write the import skipped for and that then failed leaves the sidebar at the
 * default until the next launch (issue #115). Returns an unsubscribe.
 */
export function onPreferenceWriteSettled(listener: PreferenceWriteListener): () => void {
  writeSettledListeners.add(listener);
  return () => {
    writeSettledListeners.delete(listener);
  };
}

function notifyPreferenceWriteSettled(key: string, ok: boolean): void {
  // This runs in a promise `finally`, where a throw would become an unhandled
  // rejection and skip the remaining observers; a broken observer must not be
  // able to break the write path or other observers.
  for (const listener of writeSettledListeners) {
    try {
      listener(key, ok);
    } catch {
      // a broken observer is not a failed write
    }
  }
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
  const [writeFailed, setWriteFailed] = useState(false);
  const inFlight = useRef(false);
  /** the newest change made while a write was in flight, sent once it settles */
  const queued = useRef<{ next: T } | null>(null);

  const raw = query.data?.[key];
  const value = raw === undefined ? defaultValue : parse(raw);

  function send(next: T): void {
    inFlight.current = true;
    setPending(true);
    setWriteFailed(false);
    writtenKeys.add(key);
    let failed = false;
    void writePreference(key, serialize(next))
      .then((stored) => {
        if (stored === null) {
          // the write failed; the server value stands and the caller is told
          failed = true;
          setWriteFailed(true);
          return;
        }
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
        const queuedNext = queued.current;
        queued.current = null;
        // two fast toggles must leave the server on the last one, not the first
        if (queuedNext !== null) {
          // the queued write owns the outcome; it notifies when it settles
          send(queuedNext.next);
          return;
        }
        // a failed write never became a choice, so the legacy import may take
        // over the value the server rejected
        if (failed) writtenKeys.delete(key);
        notifyPreferenceWriteSettled(key, !failed);
      });
  }

  function setValue(next: T): void {
    // synchronous guard: two clicks in one tick cannot issue two writes
    if (inFlight.current) {
      queued.current = { next };
      return;
    }
    send(next);
  }

  function updateValue(updater: (previous: T) => T): void {
    const currentRaw = queryClient.getQueryData<Preferences>(PREFERENCES_QUERY_KEY)?.[key];
    const current = currentRaw === undefined ? defaultValue : parse(currentRaw);
    setValue(updater(current));
  }

  return {
    value,
    setValue,
    updateValue,
    isPending: query.isPending,
    isWriting: pending,
    isError: query.isError,
    writeFailed,
  };
}
