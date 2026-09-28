import {
  hasPreferenceWrite,
  parseBooleanPreference,
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

/** Reactive preference for the app shell; a failed read keeps it expanded. */
export function useSidebarCollapsed() {
  return usePreference(SIDEBAR_COLLAPSED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}

/**
 * One-time import of the pre-server localStorage sidebar choice. The caller
 * runs it in the background after the shell mounts, so it never blocks the
 * scanner; it skips itself when the server already holds a sidebar value or
 * the owner made a choice while this read was in flight. A failed read or
 * write leaves the legacy value in place for the next launch; storage access
 * is guarded, so a throwing localStorage cannot break the shell.
 */
export async function migrateLegacySidebarCollapsed(): Promise<void> {
  const legacy = readLegacySidebarCollapsed();
  if (legacy === undefined) return;

  let serverValue: string | undefined;
  try {
    serverValue = (await readPreferences())[SIDEBAR_COLLAPSED_KEY];
  } catch {
    // server unreachable: keep the legacy value and retry next launch
    return;
  }
  if (serverValue !== undefined) {
    // already migrated (or chosen afresh): drop the stale legacy key
    clearLegacySidebarCollapsed();
    return;
  }
  if (hasPreferenceWrite(SIDEBAR_COLLAPSED_KEY)) {
    // the owner toggled while this read was in flight; their choice is newer
    clearLegacySidebarCollapsed();
    return;
  }

  const stored = await writePreference(SIDEBAR_COLLAPSED_KEY, serializeBooleanPreference(legacy));
  if (stored !== null) clearLegacySidebarCollapsed();
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
