import { readPreferences, usePreference, writePreference } from "@/lib/preferences";

/**
 * Getting-started dismissal and completion live server-side so a packaged-app
 * restart keeps them: the desktop shell serves the webview from a new random
 * localhost port each launch, which wipes localStorage.
 */
export const ONBOARDING_DISMISSED_KEY = "ui.onboarding.dismissed";
export const ONBOARDING_COMPLETED_KEY = "ui.onboarding.completed";

/** Only an explicit "true" hides the checklist; anything else shows it. */
export function parseOnboardingFlag(raw: string | undefined): boolean {
  return raw === "true";
}

export function serializeOnboardingFlag(value: boolean): string {
  return String(value);
}

/** Imperative read seams (tests and non-React callers). */
export async function readOnboardingDismissed(): Promise<boolean> {
  return parseOnboardingFlag((await readPreferences())[ONBOARDING_DISMISSED_KEY]);
}

export async function readOnboardingCompleted(): Promise<boolean> {
  return parseOnboardingFlag((await readPreferences())[ONBOARDING_COMPLETED_KEY]);
}

/** Imperative write seams; the failure guards live in writePreference. */
export async function writeOnboardingDismissed(): Promise<void> {
  await writePreference(ONBOARDING_DISMISSED_KEY, "true");
}

export async function writeOnboardingCompleted(): Promise<void> {
  await writePreference(ONBOARDING_COMPLETED_KEY, "true");
}

/** Reactive preference for the panel; a failed read keeps the panel shown. */
export function useOnboardingDismissed() {
  return usePreference(ONBOARDING_DISMISSED_KEY, false, parseOnboardingFlag, serializeOnboardingFlag);
}

export function useOnboardingCompleted() {
  return usePreference(ONBOARDING_COMPLETED_KEY, false, parseOnboardingFlag, serializeOnboardingFlag);
}
