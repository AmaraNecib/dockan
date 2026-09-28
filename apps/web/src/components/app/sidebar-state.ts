import {
  parseBooleanPreference,
  readPreference,
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

/** Imperative read seam (tests and non-React callers); default expanded. */
export async function readSidebarCollapsed(): Promise<boolean> {
  return parseBooleanPreference(await readPreference(SIDEBAR_COLLAPSED_KEY));
}

/** Imperative write seam; false means the session-only choice still applies. */
export async function writeSidebarCollapsed(collapsed: boolean): Promise<boolean> {
  return writePreference(SIDEBAR_COLLAPSED_KEY, serializeBooleanPreference(collapsed));
}

/** Reactive preference for the app shell; a failed read keeps it expanded. */
export function useSidebarCollapsed() {
  return usePreference(SIDEBAR_COLLAPSED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}
