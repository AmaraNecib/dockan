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

/**
 * One control over the two persisted flags that hide the checklist (issue
 * #115). The settings escape hatch must clear BOTH: `hidden = dismissed ||
 * completed`, so clearing one and leaving the other is the one-way door the
 * issue reports. Clearing `completed` only unsets the milestone — the server
 * re-records it whenever all four real records are observed, so a shop that is
 * genuinely complete has nothing to re-show.
 */
export function useGettingStartedVisibility() {
  const dismissed = useOnboardingDismissed();
  const completed = useOnboardingCompleted();

  function setVisible(next: boolean): void {
    if (next) {
      // BOTH flags must clear: `completed` alone keeps the panel hidden
      // whatever `dismissed` says, and vice versa. The two writes run
      // concurrently (two preferences, one control); each failure is surfaced
      // by the caller, and a retry converges because each write is idempotent.
      completed.setValue(false);
      dismissed.setValue(false);
      return;
    }
    dismissed.setValue(true);
  }

  return {
    visible: !dismissed.value && !completed.value,
    setVisible,
    isPending: dismissed.isPending || completed.isPending,
    isError: dismissed.isError || completed.isError,
    isWriting: dismissed.isWriting || completed.isWriting,
    writeFailed: dismissed.writeFailed || completed.writeFailed,
  };
}
