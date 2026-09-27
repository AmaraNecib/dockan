export const ONBOARDING_DISMISSED_KEY = "dokan.onboarding.dismissed";
export const ONBOARDING_COMPLETED_KEY = "dokan.onboarding.completed";

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

/**
 * True once the whole checklist was observed complete. Unlike step completion
 * (always live), this milestone is what makes "finished stays gone" hold even
 * if a later settlement removes the debt step's record.
 */
export function readOnboardingCompleted(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Remember that the whole checklist was completed, so it never nags again. */
export function writeOnboardingCompleted(): void {
  try {
    window.localStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
  } catch {
    // storage unavailable: the in-memory state still hides it for this session
  }
}
