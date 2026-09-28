import {
  parseBooleanPreference,
  readPreference,
  serializeBooleanPreference,
  usePreference,
  writePreference,
} from "@/lib/preferences";

import { ONBOARDING_COMPLETED_PREFERENCE_KEY } from "@dokan/contracts";

/**
 * Getting-started dismissal and completion live server-side so a packaged-app
 * restart keeps them: the desktop shell serves the webview from a new random
 * localhost port each launch, which wipes localStorage.
 */
export const ONBOARDING_DISMISSED_KEY = "ui.onboarding.dismissed";
/** Server-written milestone; the router and this hook share the constant. */
export const ONBOARDING_COMPLETED_KEY = ONBOARDING_COMPLETED_PREFERENCE_KEY;

/** Imperative read seams (tests and non-React callers). */
export async function readOnboardingDismissed(): Promise<boolean> {
  return parseBooleanPreference(await readPreference(ONBOARDING_DISMISSED_KEY));
}

export async function readOnboardingCompleted(): Promise<boolean> {
  return parseBooleanPreference(await readPreference(ONBOARDING_COMPLETED_KEY));
}

/** Imperative write seams; false means the session-only choice still applies. */
export async function writeOnboardingDismissed(): Promise<boolean> {
  return writePreference(ONBOARDING_DISMISSED_KEY, "true");
}

export async function writeOnboardingCompleted(): Promise<boolean> {
  return writePreference(ONBOARDING_COMPLETED_KEY, "true");
}

/** Reactive preference for the panel; a failed read keeps the panel shown. */
export function useOnboardingDismissed() {
  return usePreference(ONBOARDING_DISMISSED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}

export function useOnboardingCompleted() {
  return usePreference(ONBOARDING_COMPLETED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}
