import {
  parseBooleanPreference,
  readPreference,
  readPreferences,
  serializeBooleanPreference,
  usePreference,
  writePreference,
} from "@/lib/preferences";

/**
 * Sidebar collapse lives server-side so a packaged-app restart keeps it: the
 * desktop shell serves the webview from a new random localhost port each
 * launch, which wipes localStorage (see apps/desktop/src-tauri/src/desktop.rs).
 */
export const SIDEBAR_COLLAPSED_KEY = "ui.sidebar.collapsed";

/** The pre-server localStorage key (issue #94); imported once, then dropped. */
const LEGACY_SIDEBAR_COLLAPSED_KEY = "dokan.sidebar.collapsed";

/** Imperative read seam (tests and non-React callers); default expanded. */
export async function readSidebarCollapsed(): Promise<boolean> {
  return parseBooleanPreference(await readPreference(SIDEBAR_COLLAPSED_KEY));
}

/** Imperative write seam; false means the server did not store the choice. */
export async function writeSidebarCollapsed(collapsed: boolean): Promise<boolean> {
  return writePreference(SIDEBAR_COLLAPSED_KEY, serializeBooleanPreference(collapsed));
}

/** Reactive preference for the app shell; a failed read keeps it expanded. */
export function useSidebarCollapsed() {
  return usePreference(SIDEBAR_COLLAPSED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}

/**
 * One-time import of the pre-server localStorage sidebar choice. Runs only
 * when the server has no sidebar preference yet; a failed read or write leaves
 * the legacy value in place so the next launch retries. Storage access is
 * guarded, so a throwing localStorage cannot break the shell.
 *
 * Returns true when it wrote the server preference, so the caller can refresh
 * the shared preferences query.
 */
export async function migrateLegacySidebarCollapsed(): Promise<boolean> {
  const legacy = readLegacySidebarCollapsed();
  if (legacy === undefined) return false;

  let serverValue: string | undefined;
  try {
    serverValue = (await readPreferences())[SIDEBAR_COLLAPSED_KEY];
  } catch {
    // server unreachable: keep the legacy value and retry next launch
    return false;
  }
  if (serverValue !== undefined) {
    // already migrated (or chosen afresh): drop the stale legacy key
    clearLegacySidebarCollapsed();
    return false;
  }

  const wrote = await writePreference(SIDEBAR_COLLAPSED_KEY, serializeBooleanPreference(legacy));
  if (wrote) clearLegacySidebarCollapsed();
  return wrote;
}

function readLegacySidebarCollapsed(): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    return raw === "true" ? true : raw === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

function clearLegacySidebarCollapsed(): void {
  try {
    window.localStorage.removeItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
  } catch {
    // storage unavailable: nothing to clean up
  }
}
