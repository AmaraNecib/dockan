import { ONBOARDING_COMPLETED_PREFERENCE_KEY } from "@dokan/contracts";

import { parseBooleanPreference, serializeBooleanPreference, usePreference } from "@/lib/preferences";

/**
 * Getting-started dismissal and completion live server-side so a packaged-app
 * restart keeps them: the desktop shell serves the webview from a new random
 * localhost port each launch, which wipes localStorage. Completion is recorded
 * by the server (`onboardingComplete`), never written best-effort by the web.
 */
export const ONBOARDING_DISMISSED_KEY = "ui.onboarding.dismissed";
export const ONBOARDING_COMPLETED_KEY = ONBOARDING_COMPLETED_PREFERENCE_KEY;

/** Reactive preference for the panel; a failed read keeps the panel shown. */
export function useOnboardingDismissed() {
  return usePreference(ONBOARDING_DISMISSED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}

export function useOnboardingCompleted() {
  return usePreference(ONBOARDING_COMPLETED_KEY, false, parseBooleanPreference, serializeBooleanPreference);
}
