import { readPreferences, usePreference, writePreference } from "@/lib/preferences";

/**
 * Sidebar collapse lives server-side so a packaged-app restart keeps it: the
 * desktop shell serves the webview from a new random localhost port each
 * launch, which wipes localStorage (see apps/desktop/src-tauri/src/desktop.rs).
 */
export const SIDEBAR_COLLAPSED_KEY = "ui.sidebar.collapsed";

/**
 * The sidebar starts expanded so a first-time owner reads labels, not bare
 * icons. Only an explicit "true" collapses; an unset or stale value falls back
 * to expanded.
 */
export function parseSidebarCollapsed(raw: string | undefined): boolean {
  return raw === "true";
}

export function serializeSidebarCollapsed(collapsed: boolean): string {
  return String(collapsed);
}

/** Imperative read seam (tests and non-React callers). */
export async function readSidebarCollapsed(): Promise<boolean> {
  return parseSidebarCollapsed((await readPreferences())[SIDEBAR_COLLAPSED_KEY]);
}

/** Imperative write seam; the failure guard lives in writePreference. */
export async function writeSidebarCollapsed(collapsed: boolean): Promise<void> {
  await writePreference(SIDEBAR_COLLAPSED_KEY, serializeSidebarCollapsed(collapsed));
}

/** Reactive preference for the app shell; a failed read keeps it expanded. */
export function useSidebarCollapsed() {
  return usePreference(SIDEBAR_COLLAPSED_KEY, false, parseSidebarCollapsed, serializeSidebarCollapsed);
}
