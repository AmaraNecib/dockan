export const ONBOARDING_DISMISSED_KEY = "dokan.onboarding.dismissed";

/**
 * The getting-started panel is shown until the owner explicitly dismisses it
 * (or every step is complete from real data). Only an explicit dismissal is
 * remembered; an unset or stale value falls back to shown.
 */
export function readOnboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the owner's choice; a storage failure must not break the dismiss. */
export function writeOnboardingDismissed(): void {
  try {
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
  } catch {
    // storage unavailable: the in-memory state still applies for this session
  }
}
