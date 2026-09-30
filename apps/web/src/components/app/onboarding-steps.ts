import type { OnboardingProgress } from "@dokan/contracts";

import type { MessageKey } from "@/lib/i18n";

/**
 * The getting-started checklist, in the order a shop actually needs it. This is
 * the single ordered source of truth: the panel renders `onboardingSteps()` and
 * completion is a pure projection of the server's record-derived booleans.
 */

export type OnboardingStepId = "items" | "purchase" | "sale" | "debts";

export interface OnboardingStep {
  id: OnboardingStepId;
  /** i18n key for the step action, in the owner's shop language. */
  labelKey: MessageKey;
  /** i18n key for the one-line explanation. */
  hintKey: MessageKey;
  /** The screen where the step is actually completed. */
  to: "/items" | "/purchase" | "/sale" | "/debts";
  done: boolean;
}

interface OnboardingStepDefinition extends Omit<OnboardingStep, "done"> {
  progressKey: keyof OnboardingProgress;
}

const STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  { id: "items", labelKey: "onboardingStepItems", hintKey: "onboardingStepItemsHint", to: "/items", progressKey: "hasItems" },
  { id: "purchase", labelKey: "onboardingStepPurchase", hintKey: "onboardingStepPurchaseHint", to: "/purchase", progressKey: "hasPurchase" },
  { id: "sale", labelKey: "onboardingStepSale", hintKey: "onboardingStepSaleHint", to: "/sale", progressKey: "hasSale" },
  { id: "debts", labelKey: "onboardingStepDebts", hintKey: "onboardingStepDebtsHint", to: "/debts", progressKey: "hasDebt" },
];

/** Project the server's record-derived flags onto the four ordered steps. */
export function onboardingSteps(progress: OnboardingProgress): OnboardingStep[] {
  return STEP_DEFINITIONS.map((step) => ({
    id: step.id,
    labelKey: step.labelKey,
    hintKey: step.hintKey,
    to: step.to,
    // only a real boolean `true` marks a step done; a malformed payload that
    // omits a flag reads as pending, never as accidentally complete
    done: progress[step.progressKey] === true,
  }));
}

/** True only when every step's real record exists. */
export function isOnboardingComplete(progress: OnboardingProgress): boolean {
  return STEP_DEFINITIONS.every((step) => progress[step.progressKey] === true);
}
