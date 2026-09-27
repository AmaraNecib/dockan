const SIDEBAR_KEY = "dokan.sidebar.collapsed";

/**
 * The sidebar starts expanded so a first-time owner reads labels, not bare
 * icons. Only an explicit collapse is remembered; an unset or stale value
 * falls back to expanded.
 */
export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the owner's choice; a storage failure must not break the toggle. */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // storage unavailable: the in-memory state still applies for this session
  }
}
